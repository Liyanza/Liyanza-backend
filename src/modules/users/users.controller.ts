import {
  Controller,
  Post,
  Get,
  Patch,
  Param,
  Body,
  Request,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { Request as ExpressRequest } from 'express';
import { Role } from '@prisma/client';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { UsersService } from './users.service';
import { CreateSubAccountDto } from './dto/create-sub-account.dto';
import { UpdateUserRoleDto } from './dto/update-user-role.dto';
import { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { Roles } from '../auth/decorators/roles.decorator';
import { Public } from '../auth/decorators/public.decorator';
import { Throttle } from '@nestjs/throttler';

interface AuthenticatedRequest extends ExpressRequest {
  user: AuthenticatedUser;
}

@ApiTags('users')
@ApiBearerAuth()
@Controller('users')
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  /**
   * Create a sub‑account (admin only)
   */
  @Post()
  @Roles(Role.ADMIN)
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary:
      "Invite a member in the caller's company: new accounts get a temporary password, existing accounts get an invitation link",
  })
  @ApiResponse({
    status: 201,
    description:
      'Sub-account created (status CREATED) or invitation sent to an existing account (status INVITED)',
  })
  @ApiResponse({
    status: 409,
    description: 'Already a member, or member of another company',
  })
  async createSubAccount(
    @Body() dto: CreateSubAccountDto,
    @Request() req: AuthenticatedRequest,
  ) {
    return this.usersService.createSubAccount(dto, req.user);
  }

  /**
   * Accept a company invitation sent to an existing account (public: the
   * emailed single-use link is the proof).
   */
  @Public()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('invitations/:token/accept')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Accept a company invitation (single-use link)' })
  @ApiResponse({ status: 200, description: 'Invitation accepted' })
  @ApiResponse({ status: 400, description: 'Invalid or expired invitation' })
  async acceptInvitation(@Param('token') token: string) {
    return this.usersService.acceptInvitation(token);
  }

  /**
   * List all members of the current company (admin only)
   */
  @Get()
  @Roles(Role.ADMIN)
  @ApiOperation({ summary: "List all members of the caller's company" })
  @ApiResponse({ status: 200, description: 'Company members' })
  async findAll(@Request() req: AuthenticatedRequest) {
    return this.usersService.findAll(req.user);
  }

  /**
   * Change a user's role (admin only)
   */
  @Patch(':id/role')
  @Roles(Role.ADMIN)
  @ApiOperation({ summary: "Change a company member's role" })
  @ApiResponse({ status: 200, description: 'Role updated' })
  @ApiResponse({ status: 404, description: 'User not found' })
  async updateRole(
    @Param('id') id: string,
    @Body() dto: UpdateUserRoleDto,
    @Request() req: AuthenticatedRequest,
  ) {
    return this.usersService.updateRole(id, dto.role, req.user);
  }

  /**
   * Deactivate a user account (admin only)
   */
  @Patch(':id/deactivate')
  @Roles(Role.ADMIN)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Deactivate a company member (soft, no login)' })
  @ApiResponse({ status: 204, description: 'User deactivated' })
  @ApiResponse({ status: 404, description: 'User not found' })
  async deactivate(
    @Param('id') id: string,
    @Request() req: AuthenticatedRequest,
  ) {
    await this.usersService.deactivate(id, req.user);
  }

  /**
   * Get the authenticated user's profile (any authenticated user)
   */
  @Get('me')
  @ApiOperation({ summary: "Get the caller's own profile" })
  @ApiResponse({ status: 200, description: 'Current user profile' })
  async getProfile(@Request() req: AuthenticatedRequest) {
    return this.usersService.getProfile(req.user);
  }
}
