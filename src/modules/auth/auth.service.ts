import {
  Injectable,
  UnauthorizedException,
  ConflictException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { randomUUID } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';
import * as bcrypt from 'bcrypt';
import { Prisma, Role, User } from '@prisma/client';
import { ConfigService } from '@nestjs/config';
import type { StringValue } from 'ms';
import { JwtPayload } from './interfaces/authenticated-user.interface';
import { parseDuration } from '../../common/utils/duration.util';

/**
 * Hash bcrypt « leurre » utilisé pour égaliser le temps de réponse de
 * `login()` lorsque l'e-mail n'existe pas ou que le compte est désactivé.
 * Correspond au hash (coût 10) d'une valeur aléatoire : il ne peut donc
 * correspondre à aucun mot de passe réel.
 */
const DUMMY_BCRYPT_HASH =
  '$2b$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy';

const SALT_ROUNDS = 10;

@Injectable()
export class AuthService {
  constructor(
    private prisma: PrismaService,
    private jwtService: JwtService,
    private redisService: RedisService,
    private configService: ConfigService,
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
}
