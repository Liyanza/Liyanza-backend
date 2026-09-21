import {
  Inject,
  Injectable,
  Logger,
  UnauthorizedException,
  ConflictException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { randomBytes, randomUUID } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';
import { ForgotPasswordDto } from './dto/forgot-password.dto';
import { ResetPasswordDto } from './dto/reset-password.dto';
import { OAuthLoginCallbackQueryDto } from './dto/oauth-login-callback-query.dto';
import { OAuthExchangeDto } from './dto/oauth-exchange.dto';
import { GoogleMobileLoginDto } from './dto/google-mobile-login.dto';
import * as bcrypt from 'bcrypt';
import { Prisma, Role, User } from '@prisma/client';
import { ConfigService } from '@nestjs/config';
import type { StringValue } from 'ms';
import { JwtPayload } from './interfaces/authenticated-user.interface';
import { parseDuration } from '../../common/utils/duration.util';
import { EMAIL_PROVIDER_TOKEN } from '../mail/interfaces/email-provider.interface';
import type { EmailProvider } from '../mail/interfaces/email-provider.interface';
import {
  GOOGLE_OAUTH_CLIENT_TOKEN,
  FACEBOOK_OAUTH_CLIENT_TOKEN,
  GOOGLE_ID_TOKEN_VERIFIER_TOKEN,
} from './clients/oauth-login-client.interface';
import type {
  OAuthLoginClient,
  OAuthUserProfile,
  GoogleIdTokenVerifier,
} from './clients/oauth-login-client.interface';

type OAuthProvider = 'google' | 'facebook';

/**
 * Hash bcrypt « leurre » utilisé pour égaliser le temps de réponse de
 * `login()` lorsque l'e-mail n'existe pas ou que le compte est désactivé.
 * Correspond au hash (coût 10) d'une valeur aléatoire : il ne peut donc
 * correspondre à aucun mot de passe réel.
 */
const DUMMY_BCRYPT_HASH =
  '$2b$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy';

const SALT_ROUNDS = 10;

// 15 minutes : même durée que le `state` OAuth Meta (social-accounts), pour
// la même raison (assez large pour un login + consentement manuel, assez
// court pour limiter la fenêtre d'un `state` intercepté mais jamais utilisé).
// Porté de 10 à 15 minutes après un cas réel où le flow Facebook (saisie
// d'identifiants + écran d'autorisations, sans session Facebook déjà
// ouverte dans le navigateur) a dépassé les 10 minutes initiales.
const OAUTH_STATE_TTL_SECONDS = 900;

// 60 secondes : le temps d'une seule redirection navigateur entre ce backend
// et la page d'échange du frontend — jamais réutilisé au-delà.
const OAUTH_EXCHANGE_TTL_SECONDS = 60;

// 30 minutes : durée usuelle d'un lien de réinitialisation de mot de passe
// (compromis sécurité/UX — assez court pour limiter la fenêtre d'exploitation
// d'un email intercepté, assez long pour laisser le temps de le consulter).
const PASSWORD_RESET_TTL_SECONDS = 30 * 60;

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private prisma: PrismaService,
    private jwtService: JwtService,
    private redisService: RedisService,
    private configService: ConfigService,
    @Inject(EMAIL_PROVIDER_TOKEN) private emailProvider: EmailProvider,
    @Inject(GOOGLE_OAUTH_CLIENT_TOKEN) private googleClient: OAuthLoginClient,
    @Inject(FACEBOOK_OAUTH_CLIENT_TOKEN)
    private facebookClient: OAuthLoginClient,
    @Inject(GOOGLE_ID_TOKEN_VERIFIER_TOKEN)
    private googleIdTokenVerifier: GoogleIdTokenVerifier,
  ) {}

  // ------------------------------------------------------------------
  // Helpers de génération de tokens
  // ------------------------------------------------------------------

  private accessExpiration(): string {
    return this.configService.get<string>('jwt.accessExpiration') ?? '15m';
  }

  private refreshExpiration(): string {
    return this.configService.get<string>('jwt.refreshExpiration') ?? '7d';
  }

  /**
   * Construit un access token. Le claim `type: 'access'` est vérifié par
   * `JwtStrategy` : un refresh token ne peut donc plus être présenté comme
   * un access token.
   */
  private signAccessToken(user: {
    id: string;
    email: string;
    role: Role;
    companyId: string | null;
  }): string {
    const payload: JwtPayload = {
      sub: user.id,
      email: user.email,
      role: user.role,
      companyId: user.companyId,
      type: 'access',
    };
    return this.jwtService.sign(payload, {
      expiresIn: this.accessExpiration() as StringValue,
    });
  }

  /**
   * Construit un refresh token porteur d'un `jti` unique, puis enregistre ce
   * `jti` dans Redis. La clé Redis est indexée par `jti` (et non plus par
   * `userId`) afin de permettre plusieurs sessions simultanées par
   * utilisateur (web + mobile) sans qu'une connexion n'invalide l'autre.
   */
  private async issueRefreshToken(user: {
    id: string;
    email: string;
    role: Role;
    companyId: string | null;
  }): Promise<string> {
    const jti = randomUUID();
    const payload: JwtPayload = {
      sub: user.id,
      email: user.email,
      role: user.role,
      companyId: user.companyId,
      type: 'refresh',
      jti,
    };

    const expiresIn = this.refreshExpiration();
    const refreshToken = this.jwtService.sign(payload, {
      expiresIn: expiresIn as StringValue,
    });

    // TTL Redis aligné sur l'expiration réelle du token. `parseDuration`
    // lève si le format est invalide : on retombe alors sur 7 jours plutôt
    // que d'écrire une clé sans expiration (fuite mémoire Redis).
    let ttl = 7 * 24 * 60 * 60;
    try {
      ttl = parseDuration(expiresIn);
    } catch {
      /* valeur par défaut conservée */
    }
    if (ttl <= 0) {
      ttl = 7 * 24 * 60 * 60;
    }

    await this.redisService.set(this.refreshKey(user.id, jti), '1', ttl);
    return refreshToken;
  }

  private refreshKey(userId: string, jti: string): string {
    return `refresh:${userId}:${jti}`;
  }

  // ------------------------------------------------------------------
  // Cas d'usage
  // ------------------------------------------------------------------

  async register(dto: RegisterDto) {
    const hashedPassword = await bcrypt.hash(dto.password, SALT_ROUNDS);

    // SÉCURITÉ (correctif audit — faille critique) : le rôle et l'entreprise
    // ne sont JAMAIS déterminés à partir du payload client. Une inscription
    // publique crée toujours un utilisateur "orphelin" (sans entreprise) au
    // rôle le plus bas du domaine. Le rattachement à une entreprise se fait
    // ensuite exclusivement via `POST /entreprises` (création + auto-promotion
    // ADMIN de la NOUVELLE entreprise) ou via une invitation d'un ADMIN déjà
    // légitime (`UsersService.createSubAccount`).
    //
    // CORRECTIF AUDIT (race condition) : la vérification d'unicité préalable
    // (`findUnique` puis `create`) laissait une fenêtre pendant laquelle deux
    // inscriptions concurrentes sur le même e-mail passaient toutes deux le
    // contrôle. La seconde violait alors la contrainte `@unique` de
    // `User.email` et remontait en 500 avec le message brut de Prisma. On
    // s'appuie désormais sur la contrainte de base — seule source de vérité
    // atomique — en interceptant le code d'erreur P2002.
    let user: User;
    try {
      user = await this.prisma.user.create({
        data: {
          email: dto.email,
          password: hashedPassword,
          firstName: dto.firstName,
          lastName: dto.lastName,
          phone: dto.phone,
          role: Role.COMMUNITY_MANAGER,
          companyId: null,
        },
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        throw new ConflictException('This email is already in use.');
      }
      throw error;
    }

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { password, ...result } = user;
    return result;
  }

  async login(dto: LoginDto) {
    const user = await this.prisma.user.findUnique({
      where: { email: dto.email },
    });

    // CORRECTIF AUDIT (mineur — énumération de comptes par canal temporel) :
    // les messages d'erreur étaient déjà uniformes, mais pas le temps de
    // réponse : lorsqu'aucun utilisateur ne correspondait, la méthode
    // retournait sans exécuter `bcrypt.compare` (~60-100 ms au coût 10),
    // permettant de distinguer un e-mail existant d'un e-mail inconnu. On
    // exécute désormais systématiquement une comparaison bcrypt, sur un hash
    // leurre le cas échéant.
    const isActive = Boolean(user) && !user!.deactivatedAt;
    const passwordMatches = await bcrypt.compare(
      dto.password,
      user?.password ?? DUMMY_BCRYPT_HASH,
    );

    if (!user || !isActive || !passwordMatches) {
      throw new UnauthorizedException('Invalid credentials.');
    }

    const accessToken = this.signAccessToken(user);
    const refreshToken = await this.issueRefreshToken(user);

    return {
      accessToken,
      refreshToken,
      user: {
        id: user.id,
        email: user.email,
        firstName: user.firstName,
        lastName: user.lastName,
        role: user.role,
      },
    };
  }

  /**
   * Échange un refresh token contre un nouvel access token ET un nouveau
   * refresh token (rotation).
   *
   * CORRECTIF AUDIT (faille critique — privilèges figés) : le nouvel access
   * token était auparavant construit à partir des claims `role` / `companyId`
   * de l'ANCIEN token. Un utilisateur rétrogradé par un ADMIN conservait donc
   * ses privilèges pendant toute la durée de vie du refresh token (7 jours),
   * simplement en le rafraîchissant. Le rôle et l'entreprise sont désormais
   * systématiquement relus en base.
   *
   * CORRECTIF AUDIT (majeur — absence de rotation) : le refresh token est
   * désormais à usage unique. Son `jti` est retiré de Redis de façon atomique
   * (`GETDEL`) et un nouveau couple de tokens est émis. Un token rejoué est
   * rejeté.
   */
  async refresh(refreshToken: string) {
    let payload: JwtPayload;
    try {
      payload = this.jwtService.verify<JwtPayload>(refreshToken);
    } catch {
      throw new UnauthorizedException('Invalid or expired refresh token.');
    }

    // Un access token ne doit jamais pouvoir être échangé contre une session.
    if (payload.type !== 'refresh' || !payload.jti || !payload.sub) {
      throw new UnauthorizedException('Invalid refresh token.');
    }
    // `jti` est optionnel sur `JwtPayload` (porté uniquement par les refresh
    // tokens). On le capture dans un `const` local juste après le guard
    // ci-dessus : le narrowing TypeScript sur une constante est sans
    // ambiguïté, contrairement à des accès répétés à `payload.jti` sur une
    // variable `let` reléguée à travers plusieurs lignes.
    const { sub, jti } = payload;

    // Consommation atomique : au plus un appel concurrent obtient la valeur.
    const consumed = await this.redisService.getDel(this.refreshKey(sub, jti));
    if (!consumed) {
      throw new UnauthorizedException('Invalid or expired refresh token.');
    }

    // Le rôle et l'entreprise font autorité en base, jamais dans le token.
    const user = await this.prisma.user.findUnique({
      where: { id: sub },
      select: {
        id: true,
        email: true,
        role: true,
        companyId: true,
        deactivatedAt: true,
      },
    });
    if (!user || user.deactivatedAt) {
      throw new UnauthorizedException('Invalid refresh token.');
    }

    return {
      accessToken: this.signAccessToken(user),
      refreshToken: await this.issueRefreshToken(user),
    };
  }

  /**
   * Révoque une session. Si un refresh token est fourni, seule cette session
   * est fermée ; sinon toutes les sessions de l'utilisateur le sont.
   */
  async logout(userId: string, refreshToken?: string) {
    if (refreshToken) {
      try {
        const payload = this.jwtService.verify<JwtPayload>(refreshToken);
        // `jti` capturé dans un `const` local dès que sa présence est
        // garantie par le `&&` précédent, pour un narrowing sans ambiguïté
        // (même raison que dans `refresh()` ci-dessus).
        const jti = payload.jti;
        if (payload.type === 'refresh' && jti && payload.sub === userId) {
          await this.redisService.del(this.refreshKey(userId, jti));
          return { success: true };
        }
      } catch {
        /* token illisible : on retombe sur la révocation globale ci-dessous */
      }
    }

    await this.redisService.delByPattern(`refresh:${userId}:*`);
    return { success: true };
  }

  // ------------------------------------------------------------------
  // BACK-505 — Connexion Google/Facebook
  //
  // DISTINCT du flow OAuth Meta de `SocialAccountsService` (BACK-502/503) :
  // celui-ci authentifie un utilisateur ANONYME (pas de JWT, pas de contexte
  // entreprise à restituer) — le `state` n'est donc qu'un nonce anti-CSRF,
  // jamais un payload chiffré à déchiffrer au callback.
  // ------------------------------------------------------------------

  private oauthClient(provider: OAuthProvider): OAuthLoginClient {
    return provider === 'google' ? this.googleClient : this.facebookClient;
  }

  private oauthRedirectUriConfigKey(provider: OAuthProvider): string {
    return provider === 'google'
      ? 'GOOGLE_OAUTH_REDIRECT_URI'
      : 'FACEBOOK_LOGIN_REDIRECT_URI';
  }

  private oauthStateKey(state: string): string {
    return `oauth-login-state:${state}`;
  }

  private oauthExchangeKey(code: string): string {
    return `oauth-exchange:${code}`;
  }

  private passwordResetKey(token: string): string {
    return `password-reset:${token}`;
  }

  private buildOAuthResultUrl(
    base: string,
    status: 'success' | 'error',
    params: Record<string, string | undefined>,
  ): string {
    const url = new URL(base);
    url.searchParams.set('status', status);
    for (const [key, value] of Object.entries(params)) {
      if (value) url.searchParams.set(key, value);
    }
    return url.toString();
  }

  async startOAuthLogin(provider: OAuthProvider) {
    const state = randomBytes(24).toString('base64url');
    await this.redisService.set(
      this.oauthStateKey(state),
      '1',
      OAUTH_STATE_TTL_SECONDS,
    );

    const redirectUri = this.configService.getOrThrow<string>(
      this.oauthRedirectUriConfigKey(provider),
    );

    return {
      authorizationUrl: this.oauthClient(provider).getAuthorizationUrl(
        state,
        redirectUri,
      ),
    };
  }

  /**
   * Callback public appelé directement par le navigateur après consentement
   * (ou refus) côté Google/Facebook — jamais de JWT ici, l'utilisateur n'est
   * pas encore authentifié. Ne renvoie jamais de token dans l'URL de
   * redirection : seulement un code d'échange à usage unique et de très
   * courte durée de vie (voir `exchangeOAuthCode`).
   */
  async handleOAuthLoginCallback(
    provider: OAuthProvider,
    query: OAuthLoginCallbackQueryDto,
  ) {
    const frontendBase = this.configService.getOrThrow<string>(
      'OAUTH_LOGIN_REDIRECT_URL',
    );

    if (query.error) {
      this.logger.warn(
        `${provider} OAuth denied/error: ${query.error} — ${query.error_description ?? ''}`,
      );
      return {
        redirectUrl: this.buildOAuthResultUrl(frontendBase, 'error', {
          reason: 'denied',
        }),
      };
    }

    // Consommation atomique du nonce — au plus un appelant concurrent (rejeu
    // du callback, double redirection navigateur) obtient un `state` valide.
    const consumed = await this.redisService.getDel(
      this.oauthStateKey(query.state),
    );
    if (!consumed) {
      return {
        redirectUrl: this.buildOAuthResultUrl(frontendBase, 'error', {
          reason: 'invalid_or_expired_state',
        }),
      };
    }

    if (!query.code) {
      return {
        redirectUrl: this.buildOAuthResultUrl(frontendBase, 'error', {
          reason: 'missing_code',
        }),
      };
    }

    try {
      const redirectUri = this.configService.getOrThrow<string>(
        this.oauthRedirectUriConfigKey(provider),
      );
      const profile = await this.oauthClient(provider).exchangeCodeForProfile(
        query.code,
        redirectUri,
      );
      const user = await this.findOrCreateOAuthUser(provider, profile);

      if (user.deactivatedAt) {
        return {
          redirectUrl: this.buildOAuthResultUrl(frontendBase, 'error', {
            reason: 'account_disabled',
          }),
        };
      }

      const accessToken = this.signAccessToken(user);
      const refreshToken = await this.issueRefreshToken(user);
      const exchangeCode = randomBytes(32).toString('base64url');

      await this.redisService.set(
        this.oauthExchangeKey(exchangeCode),
        JSON.stringify({
          accessToken,
          refreshToken,
          user: {
            id: user.id,
            email: user.email,
            firstName: user.firstName,
            lastName: user.lastName,
            role: user.role,
          },
        }),
        OAUTH_EXCHANGE_TTL_SECONDS,
      );

      return {
        redirectUrl: this.buildOAuthResultUrl(frontendBase, 'success', {
          code: exchangeCode,
        }),
      };
    } catch (error) {
      this.logger.error(
        `${provider} OAuth login callback failed`,
        error instanceof Error ? error.stack : String(error),
      );
      return {
        redirectUrl: this.buildOAuthResultUrl(frontendBase, 'error', {
          reason: 'exchange_failed',
        }),
      };
    }
  }

  /**
   * Appelée par le frontend (jamais directement par le navigateur) juste
   * après la redirection : échange le code d'échange à usage unique contre
   * la vraie paire de tokens. `GETDEL` garantit qu'un code intercepté (log
   * d'accès, historique navigateur) ne peut être rejoué, et seulement dans
   * les `OAUTH_EXCHANGE_TTL_SECONDS` suivant son émission.
   */
  async exchangeOAuthCode(dto: OAuthExchangeDto) {
    const raw = await this.redisService.getDel(this.oauthExchangeKey(dto.code));
    if (!raw) {
      throw new UnauthorizedException('Invalid or expired exchange code.');
    }
    return JSON.parse(raw) as {
      accessToken: string;
      refreshToken: string;
      user: {
        id: string;
        email: string;
        firstName: string;
        lastName: string;
        role: Role;
      };
    };
  }

  /**
   * BACK-507 — Connexion Google DEPUIS L'APP MOBILE (Flutter, `google_sign_in`).
   * Contrairement à `handleOAuthLoginCallback` ci-dessus, l'app a déjà résolu
   * l'identité de l'utilisateur nativement : pas de `state`, pas de
   * redirection, pas de code d'échange à courte durée de vie — un seul
   * aller-retour qui renvoie directement la paire de tokens, exactement comme
   * `login()`.
   */
  async loginWithGoogleIdToken(dto: GoogleMobileLoginDto) {
    let profile: OAuthUserProfile;
    try {
      profile = await this.googleIdTokenVerifier.verifyIdToken(dto.idToken);
    } catch (error) {
      this.logger.warn(
        `Google mobile login rejected: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      throw new UnauthorizedException('Invalid Google idToken.');
    }

    const user = await this.findOrCreateOAuthUser('google', profile);

    if (user.deactivatedAt) {
      throw new UnauthorizedException('Account disabled.');
    }

    const accessToken = this.signAccessToken(user);
    const refreshToken = await this.issueRefreshToken(user);

    return {
      accessToken,
      refreshToken,
      user: {
        id: user.id,
        email: user.email,
        firstName: user.firstName,
        lastName: user.lastName,
        role: user.role,
      },
    };
  }

  /**
   * Associe/rattache un compte OAuth à un utilisateur Liyanza :
   * 1. déjà lié à ce provider → on le renvoie tel quel ;
   * 2. email déjà inscrit (compte mot de passe préexistant) → on LIE le
   *    compte au lieu d'en créer un doublon (même personne, même identifiant
   *    métier `email`) ;
   * 3. sinon, nouveau compte — même règle de sécurité que `register()` :
   *    rôle le plus bas, pas d'entreprise, jamais déterminé par une donnée
   *    externe (ici le profil du provider).
   */
  private async findOrCreateOAuthUser(
    provider: OAuthProvider,
    profile: OAuthUserProfile,
  ): Promise<User> {
    const existingByProviderId = await this.prisma.user.findUnique({
      where:
        provider === 'google'
          ? { googleId: profile.providerId }
          : { facebookId: profile.providerId },
    });
    if (existingByProviderId) {
      return existingByProviderId;
    }

    const existingByEmail = await this.prisma.user.findUnique({
      where: { email: profile.email },
    });
    if (existingByEmail) {
      return this.prisma.user.update({
        where: { id: existingByEmail.id },
        data:
          provider === 'google'
            ? { googleId: profile.providerId }
            : { facebookId: profile.providerId },
      });
    }

    try {
      return await this.prisma.user.create({
        data: {
          email: profile.email,
          firstName: profile.firstName,
          lastName: profile.lastName,
          role: Role.COMMUNITY_MANAGER,
          companyId: null,
          password: null,
          phone: null,
          googleId: provider === 'google' ? profile.providerId : null,
          facebookId: provider === 'facebook' ? profile.providerId : null,
        },
      });
    } catch (error) {
      // CORRECTIF AUDIT (même race condition que register()) : deux
      // connexions OAuth concurrentes sur un email jamais vu peuvent toutes
      // deux passer le findUnique ci-dessus. La contrainte @unique sur
      // `email` est la seule source de vérité atomique.
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        return this.prisma.user.findUniqueOrThrow({
          where: { email: profile.email },
        });
      }
      throw error;
    }
  }

  // ------------------------------------------------------------------
  // BACK-506 — Réinitialisation de mot de passe
  // ------------------------------------------------------------------

  /**
   * Ne révèle JAMAIS si l'email correspond à un compte existant (même
   * garde-fou que `login()` — énumération de comptes) : toujours `{success:
   * true}`, un email n'est envoyé que si un compte actif ET disposant d'un
   * mot de passe local correspond (un compte 100% Google/Facebook n'a rien à
   * réinitialiser).
   */
  async forgotPassword(dto: ForgotPasswordDto): Promise<{ success: true }> {
    const user = await this.prisma.user.findUnique({
      where: { email: dto.email },
    });

    if (user && !user.deactivatedAt && user.password) {
      const token = randomBytes(32).toString('base64url');
      await this.redisService.set(
        this.passwordResetKey(token),
        user.id,
        PASSWORD_RESET_TTL_SECONDS,
      );

      const resetUrl = new URL(
        this.configService.getOrThrow<string>('PASSWORD_RESET_URL'),
      );
      resetUrl.searchParams.set('token', token);

      // Best-effort : un échec d'envoi ne doit ni renseigner l'appelant sur
      // l'existence du compte (voir commentaire ci-dessus), ni faire échouer
      // cette requête publique.
      await this.emailProvider
        .send({
          to: user.email,
          subject: 'Réinitialisation de votre mot de passe Liyanza',
          text: `Bonjour ${user.firstName},\n\nVous avez demandé la réinitialisation de votre mot de passe Liyanza. Cliquez sur le lien suivant (valable 30 minutes) pour choisir un nouveau mot de passe :\n\n${resetUrl.toString()}\n\nSi vous n'êtes pas à l'origine de cette demande, ignorez cet email : votre mot de passe restera inchangé.`,
        })
        .catch((error: unknown) => {
          this.logger.error(
            `Failed to send password reset email to user ${user.id}`,
            error instanceof Error ? error.stack : String(error),
          );
        });
    }

    return { success: true };
  }

  /**
   * CORRECTIF AUDIT (cohérence avec le reste du module) : une réinitialisation
   * de mot de passe révoque TOUTES les sessions existantes (`refresh:userId:*`)
   * — sans quoi un attaquant disposant déjà d'un refresh token volé
   * conserverait l'accès après que la victime a « sécurisé » son compte.
   */
  async resetPassword(dto: ResetPasswordDto): Promise<{ success: true }> {
    const userId = await this.redisService.getDel(
      this.passwordResetKey(dto.token),
    );
    if (!userId) {
      throw new UnauthorizedException('Invalid or expired reset token.');
    }

    const hashedPassword = await bcrypt.hash(dto.newPassword, SALT_ROUNDS);
    await this.prisma.user.update({
      where: { id: userId },
      data: { password: hashedPassword },
    });
    await this.redisService.delByPattern(`refresh:${userId}:*`);

    return { success: true };
  }
}
