import { NotFoundException } from '@nestjs/common';
import { Role } from '@prisma/client';
import {
  assertSameCompany,
  assertSameCompanyUnless,
} from './company-scope.util';
import { AuthenticatedUser } from '../interfaces/authenticated-user.interface';

describe('assertSameCompany', () => {
  const user: AuthenticatedUser = {
    userId: 'u1',
    email: 'a@test.com',
    role: Role.ADMIN,
    companyId: 'company-1',
  };

  it('should not throw when the resource companyId matches the user companyId', () => {
    expect(() => assertSameCompany(user, 'company-1')).not.toThrow();
  });

  // RÉGRESSION (isolation multi-tenant) : mismatch = 404, jamais 403 — pour
  // ne pas révéler l'existence de ressources d'entreprises tierces.
  it('should throw NotFoundException (not Forbidden) when the resource belongs to another company', () => {
    expect(() => assertSameCompany(user, 'other-company')).toThrow(
      NotFoundException,
    );
  });

  it('should throw NotFoundException when the user has no company', () => {
    expect(() =>
      assertSameCompany({ ...user, companyId: null }, 'company-1'),
    ).toThrow(NotFoundException);
  });

  it('should throw NotFoundException when the resource companyId is null or undefined', () => {
    expect(() => assertSameCompany(user, null)).toThrow(NotFoundException);
    expect(() => assertSameCompany(user, undefined)).toThrow(NotFoundException);
  });

  it('should include the given resource name in the error message', () => {
    expect(() => assertSameCompany(user, 'other-company', 'Campagne')).toThrow(
      'Campagne introuvable.',
    );
  });

  it('should default the resource name to "Ressource" when not provided', () => {
    expect(() => assertSameCompany(user, 'other-company')).toThrow(
      'Ressource introuvable.',
    );
  });
});

describe('assertSameCompanyUnless', () => {
  const user: AuthenticatedUser = {
    userId: 'u1',
    email: 'a@test.com',
    role: Role.ADMIN,
    companyId: 'company-1',
  };

  it('should bypass the company check entirely when the user role is in bypassRoles', () => {
    expect(() =>
      assertSameCompanyUnless(user, 'other-company', [Role.ADMIN]),
    ).not.toThrow();
  });

  it('should still enforce the company check when the user role is not in bypassRoles', () => {
    expect(() =>
      assertSameCompanyUnless(user, 'other-company', [Role.PROVIDER]),
    ).toThrow(NotFoundException);
  });

  it('should allow access on a matching company even without a bypass role', () => {
    expect(() =>
      assertSameCompanyUnless(user, 'company-1', [Role.PROVIDER]),
    ).not.toThrow();
  });
});
