import {
  Controller,
  Get,
  Patch,
  Param,
  Query,
  Request,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { Request as ExpressRequest } from 'express';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { NotificationsService } from './notifications.service';
import { NotificationQueryDto } from './dto/notification-query.dto';
import { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';

interface AuthenticatedRequest extends ExpressRequest {
  user: AuthenticatedUser;
}

@ApiTags('notifications')
@ApiBearerAuth()
@Controller('notifications')
export class NotificationsController {
  constructor(private readonly notificationsService: NotificationsService) {}

  /**
   * GET /notifications
   * Returns the authenticated user's notifications, optionally filtered by read status.
   * Accessible to any authenticated user (JwtAuthGuard global).
   */
  @Get()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "List the caller's own notifications" })
  @ApiResponse({ status: 200, description: 'Paginated notifications' })
  async findAll(
    @Request() req: AuthenticatedRequest,
    @Query() query: NotificationQueryDto,
  ) {
    return this.notificationsService.findAll(req.user, query);
  }

  /**
   * PATCH /notifications/:id/lue
   * Marks a notification as read. Idempotent: if already read, returns the notification.
   */
  @Patch(':id/lue')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Mark a notification as read (idempotent)' })
  @ApiResponse({ status: 200, description: 'Notification marked as read' })
  @ApiResponse({ status: 404, description: 'Notification not found' })
  async markAsLue(
    @Param('id') id: string,
    @Request() req: AuthenticatedRequest,
  ) {
    return this.notificationsService.markAsLue(id, req.user);
  }
}
