import { Role } from '@prisma/client';

export class UserResponseDto {
  id!: string;
  email!: string;
  firstName!: string;
  lastName!: string;
  phone!: string;
  role!: Role;
  companyId!: string | null;
  createdAt!: Date;
  deactivatedAt!: Date | null;
}
