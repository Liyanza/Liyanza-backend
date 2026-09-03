import { Injectable, NestMiddleware } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { Request, Response, NextFunction } from 'express';
import { Role } from '@prisma/client';
import { JwtPayload } from '../auth/interfaces/authenticated-user.interface';

interface AuthenticatedRequest extends Request {
  user?: JwtPayload;
}

@Injectable()
export class QueueAuthMiddleware implements NestMiddleware {
  constructor(
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
  ) {}

  use(req: AuthenticatedRequest, res: Response, next: NextFunction): void {
    const authHeader = req.headers.authorization;
    if (!authHeader) {
      res.status(401).json({ message: 'Missing authorization header' });
      return;
    }
    const parts = authHeader.split(' ');
    if (parts.length !== 2 || parts[0] !== 'Bearer') {
      res.status(401).json({ message: 'Invalid authorization format' });
      return;
    }
    const token = parts[1];
    try {
      const secret = this.configService.get<string>('JWT_SECRET');
      if (!secret) {
        res.status(500).json({ message: 'Server configuration error' });
        return;
      }
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
      const payload = this.jwtService.verify(token, { secret }) as JwtPayload;
      if (payload.role !== Role.ADMIN) {
        res.status(403).json({ message: 'Access denied: ADMIN role required' });
        return;
      }
      req.user = payload;
      next();
    } catch {
      res.status(401).json({ message: 'Invalid or expired token' });
    }
  }
}
