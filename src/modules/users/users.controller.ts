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
      "Invite a sub-account in the caller's company (temporary password emailed)",
  })
  @ApiResponse({ status: 201, description: 'Sub-account created' })
  async createSubAccount(
    @Body() dto: CreateSubAccountDto,
    @Request() req: AuthenticatedRequest,
  ) {
    return this.usersService.createSubAccount(dto, req.user);
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
