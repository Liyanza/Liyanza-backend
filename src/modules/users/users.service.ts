import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  ForbiddenException,
  ConflictException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as bcrypt from 'bcrypt';
import { randomBytes } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { CreateSubAccountDto } from './dto/create-sub-account.dto';
import { Role } from '@prisma/client';
import { NotificationsService } from '../notifications/notifications.service';
import { NotificationType } from '../notifications/dto/create-notification.dto';
import { QueueService } from '../queue/queue.service';
import { RedisService } from '../redis/redis.service';
import { EMAIL_PROVIDER_TOKEN } from '../mail/interfaces/email-provider.interface';
import type { EmailProvider } from '../mail/interfaces/email-provider.interface';

/** Durée de validité d'une invitation envoyée à un compte existant. */
const INVITATION_TTL_SECONDS = 7 * 24 * 60 * 60;

/** Contenu d'une invitation en attente (Redis, clé `company-invitation:<token>`). */
interface PendingInvitation {
  userId: string;
  companyId: string;
  role: Role;
  invitedBy: string;
}

@Injectable()
export class UsersService {
  private readonly logger = new Logger(UsersService.name);

  constructor(
    private prisma: PrismaService,
    private notificationsService: NotificationsService,
    private queueService: QueueService,
    private redisService: RedisService,
    private configService: ConfigService,
    @Inject(EMAIL_PROVIDER_TOKEN) private emailProvider: EmailProvider,
  ) {}

  private invitationKey(token: string): string {
    return `company-invitation:${token}`;
  }

  /**
   * Page du frontend qui accepte l'invitation. `INVITATION_URL` si défini,
   * sinon `/invitation` sur le même domaine que `PASSWORD_RESET_URL` (déjà
   * obligatoire) — aucune nouvelle variable d'environnement requise.
   */
  private invitationUrl(token: string): string {
    const configured = this.configService.get<string>('INVITATION_URL');
    const url = configured
      ? new URL(configured)
      : new URL(
          '/invitation',
          this.configService.getOrThrow<string>('PASSWORD_RESET_URL'),
        );
    url.searchParams.set('token', token);
    return url.toString();
  }

  private generateTemporaryPassword(): string {
    return randomBytes(8).toString('hex');
  }

  async createSubAccount(dto: CreateSubAccountDto, admin: AuthenticatedUser) {
    if (!admin.companyId) {
      throw new ForbiddenException(
        'You must belong to a company to create a sub‑account.',
      );
    }

    const existing = await this.prisma.user.findUnique({
      where: { email: dto.email },
    });
    if (existing) {
      return this.inviteExistingUser(existing, dto.role, admin);
    }

    const plainPassword = this.generateTemporaryPassword();
    const hashedPassword = await bcrypt.hash(plainPassword, 10);

    const user = await this.prisma.user.create({
      data: {
        email: dto.email,
        password: hashedPassword,
        firstName: dto.firstName,
        lastName: dto.lastName,
        phone: dto.phone,
        role: dto.role,
        companyId: admin.companyId,
      },
    });

    // Create a notification for the admin (Phase 3 will handle actual sending)
    await this.notificationsService.creer({
      title: 'Sous-compte créé',
      message: `Un nouveau sous-compte a été créé pour ${user.email} (${dto.role}).`,
      type: NotificationType.INFO,
      recipientId: admin.userId,
    });

    // CORRECTIF AUDIT (mineur) : le mot de passe temporaire ne doit plus
    // jamais transiter par les logs applicatifs (même hors production —
    // les logs de staging sont souvent collectés/persistés). Il est
    // désormais transmis via la queue `notifications`, à charge pour un
    // processor dédié (canal email/SMS) de le délivrer à l'utilisateur.
    // Le secret ne persiste dans aucune table de la base de données.
    await this.queueService.addJob('notifications', 'send-temporary-password', {
      email: user.email,
      firstName: user.firstName,
      temporaryPassword: plainPassword,
    });

    // Exclude password from the response
    const result = {
      status: 'CREATED' as const,
      id: user.id,
      email: user.email,
      firstName: user.firstName,
      lastName: user.lastName,
      phone: user.phone,
      role: user.role,
      companyId: user.companyId,
      createdAt: user.createdAt,
      deactivatedAt: user.deactivatedAt,
    };
    return result;
  }

  /**
   * Le compte existe déjà (inscription directe, Google/Facebook...) : pas de
   * nouveau compte ni de mot de passe temporaire. On lui envoie un lien à
   * usage unique qui le rattache à l'entreprise avec le rôle choisi.
   * Un compte ne peut appartenir qu'à une seule entreprise : on refuse s'il
   * fait déjà partie d'une autre (le retirer pourrait laisser celle-ci sans
   * administrateur).
   */
  private async inviteExistingUser(
    existing: {
      id: string;
      email: string;
      firstName: string;
      lastName: string;
      companyId: string | null;
      deactivatedAt: Date | null;
    },
    role: Role,
    admin: AuthenticatedUser,
  ) {
    if (existing.companyId === admin.companyId) {
      throw new ConflictException(
        'This user is already a member of your company.',
      );
    }
    if (existing.companyId) {
      throw new ConflictException(
        'This user already belongs to another company.',
      );
    }
    if (existing.deactivatedAt) {
      throw new ConflictException('This account has been deactivated.');
    }

    const company = await this.prisma.company.findUnique({
      where: { id: admin.companyId! },
      select: { name: true },
    });

    const token = randomBytes(32).toString('base64url');
    const invitation: PendingInvitation = {
      userId: existing.id,
      companyId: admin.companyId!,
      role,
      invitedBy: admin.userId,
    };
    await this.redisService.set(
      this.invitationKey(token),
      JSON.stringify(invitation),
      INVITATION_TTL_SECONDS,
    );

    // Contrairement au mot de passe oublié, l'appelant doit savoir si l'envoi
    // a échoué : l'invitation serait sinon perdue sans que l'admin le sache.
    await this.emailProvider.send({
      to: existing.email,
      subject: `Invitation à rejoindre ${company?.name ?? 'une entreprise'} sur Liyanza`,
      text: `Bonjour ${existing.firstName},\n\nVous êtes invité(e) à rejoindre l'entreprise ${company?.name ?? ''} sur Liyanza. Votre compte existe déjà : il vous suffit de cliquer sur le lien suivant (valable 7 jours) pour accepter l'invitation, puis de vous connecter comme d'habitude.\n\n${this.invitationUrl(token)}\n\nSi vous ne connaissez pas cette entreprise, ignorez simplement cet email.`,
    });

    return {
      status: 'INVITED' as const,
      email: existing.email,
      firstName: existing.firstName,
      lastName: existing.lastName,
    };
  }

  /**
   * Route publique (le lien suffit, comme pour la réinitialisation de mot de
   * passe : il prouve l'accès à la boîte mail). Usage unique (GETDEL), et on
   * revérifie l'état du compte au moment de l'acceptation.
   */
  async acceptInvitation(token: string) {
    const raw = await this.redisService.getDel(this.invitationKey(token));
    if (!raw) {
      throw new BadRequestException('Invalid or expired invitation.');
    }
    const invitation = JSON.parse(raw) as PendingInvitation;

    const user = await this.prisma.user.findUnique({
      where: { id: invitation.userId },
    });
    if (!user || user.deactivatedAt) {
      throw new BadRequestException('Invalid or expired invitation.');
    }
    if (user.companyId && user.companyId !== invitation.companyId) {
      throw new ConflictException(
        'This user already belongs to another company.',
      );
    }

    const company = await this.prisma.company.findUnique({
      where: { id: invitation.companyId },
      select: { name: true, deletedAt: true },
    });
    if (!company || company.deletedAt) {
      throw new BadRequestException('Invalid or expired invitation.');
    }

    if (!user.companyId) {
      await this.prisma.user.update({
        where: { id: user.id },
        data: { companyId: invitation.companyId, role: invitation.role },
      });
      await this.notificationsService
        .creer({
          title: 'Invitation acceptée',
          message: `${user.firstName} ${user.lastName} (${user.email}) a rejoint l'entreprise.`,
          type: NotificationType.INFO,
          recipientId: invitation.invitedBy,
        })
        .catch((error: unknown) => {
          this.logger.warn(
            `Invitation accepted but notification failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        });
    }

    return {
      success: true as const,
      companyName: company.name,
      email: user.email,
    };
  }

  async findAll(admin: AuthenticatedUser) {
    if (!admin.companyId) {
      throw new ForbiddenException(
        'You must belong to a company to list users.',
      );
    }

    return this.prisma.user.findMany({
      where: { companyId: admin.companyId },
      select: {
        id: true,
        email: true,
        firstName: true,
        lastName: true,
        phone: true,
        role: true,
        companyId: true,
        createdAt: true,
        deactivatedAt: true,
      },
      orderBy: { createdAt: 'asc' },
    });
  }

  async updateRole(userId: string, newRole: Role, admin: AuthenticatedUser) {
    if (!admin.companyId) {
      throw new ForbiddenException(
        'You must belong to a company to update a user.',
      );
    }

    if (userId === admin.userId) {
      throw new ForbiddenException('You cannot change your own role.');
    }

    const targetUser = await this.prisma.user.findUnique({
      where: { id: userId },
    });
    if (!targetUser || targetUser.companyId !== admin.companyId) {
      throw new NotFoundException('User not found.');
    }

    return this.prisma.user.update({
      where: { id: userId },
      data: { role: newRole },
      select: {
        id: true,
        email: true,
        firstName: true,
        lastName: true,
        phone: true,
        role: true,
        companyId: true,
        createdAt: true,
        deactivatedAt: true,
      },
    });
  }

  async deactivate(userId: string, admin: AuthenticatedUser) {
    if (!admin.companyId) {
      throw new ForbiddenException(
        'You must belong to a company to deactivate a user.',
      );
    }

    const targetUser = await this.prisma.user.findUnique({
      where: { id: userId },
    });
    if (!targetUser || targetUser.companyId !== admin.companyId) {
      throw new NotFoundException('User not found.');
    }

    await this.prisma.user.update({
      where: { id: userId },
      data: { deactivatedAt: new Date() },
    });
  }

  async getProfile(user: AuthenticatedUser) {
    const dbUser = await this.prisma.user.findUnique({
      where: { id: user.userId },
      select: {
        id: true,
        email: true,
        firstName: true,
        lastName: true,
        phone: true,
        role: true,
        companyId: true,
        createdAt: true,
        deactivatedAt: true,
      },
    });
    if (!dbUser) {
      throw new NotFoundException('User not found.');
    }
    return dbUser;
  }
}
