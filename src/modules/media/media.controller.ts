import {
  Controller,
  Post,
  Get,
  Param,
  Body,
  Request,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { Request as ExpressRequest } from 'express';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { MediaService } from './media.service';
import { CreatePresignedUploadDto } from './dto/create-presigned-upload.dto';
import { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';

interface AuthenticatedRequest extends ExpressRequest {
  user: AuthenticatedUser;
}

@ApiTags('media')
@Controller('media')
export class MediaController {
  constructor(private readonly mediaService: MediaService) {}

  @Post('presigned-upload')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary:
      'Reserve a storage slot and return a short-lived presigned PUT URL for direct client upload',
  })
  @ApiResponse({ status: 201, description: 'Presigned upload URL issued' })
  async createPresignedUpload(
    @Body() dto: CreatePresignedUploadDto,
    @Request() req: AuthenticatedRequest,
  ) {
    return this.mediaService.createPresignedUpload(dto, req.user);
  }

  @Post(':id/confirm')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Confirm a completed upload — verifies the object actually exists on storage',
  })
  @ApiResponse({ status: 200, description: 'Media confirmed' })
  async confirmUpload(
    @Param('id') id: string,
    @Request() req: AuthenticatedRequest,
  ) {
    return this.mediaService.confirmUpload(id, req.user);
  }

  @Get(':id/url')
  @ApiOperation({
    summary: 'Get a short-lived presigned download URL for a confirmed media',
  })
  @ApiResponse({ status: 200, description: 'Presigned download URL issued' })
  async getDownloadUrl(
    @Param('id') id: string,
    @Request() req: AuthenticatedRequest,
  ) {
    return this.mediaService.getDownloadUrl(id, req.user);
  }
}
