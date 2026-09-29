import { ServiceUnavailableException } from '@nestjs/common';
import { Role } from '@prisma/client';
import { CampaignDescriptionController } from './campaign-description.controller';
import type { PrismaService } from '../prisma/prisma.service';
import type { CampaignDescriptionClient } from './clients/campaign-description.client';

describe('CampaignDescriptionController', () => {
  const req = {
    user: {
      userId: 'u1',
      email: 'a@b.c',
      role: Role.MARKETING_MANAGER,
      companyId: 'company-1',
    },
  } as never;
  const company = {
    name: 'Nexclean',
    businessSector: 'Services',
    address: 'Douala',
  };

  let describe_: jest.Mock;
  let controller: CampaignDescriptionController;

  beforeEach(() => {
    describe_ = jest.fn();
    controller = new CampaignDescriptionController(
      {
        company: { findUnique: jest.fn().mockResolvedValue(company) },
      } as unknown as PrismaService,
      { describe: describe_ } as unknown as CampaignDescriptionClient,
    );
  });

  it('should draft a description with the company profile', async () => {
    describe_.mockResolvedValue('Une description.');

    await expect(
      controller.describe(
        {
          name: 'Promo rentrée',
          product: 'Nettoyage de canapés',
          objective: 'LEADS',
        },
        req,
      ),
    ).resolves.toEqual({ description: 'Une description.' });
    expect(describe_).toHaveBeenCalledWith({
      name: 'Promo rentrée',
      product: 'Nettoyage de canapés',
      objective: 'LEADS',
      companyProfile: company,
    });
  });

  it('should answer 503 when the AI is not configured or fails', async () => {
    describe_.mockResolvedValueOnce(null);
    await expect(
      controller.describe({ name: 'A', product: 'B' }, req),
    ).rejects.toThrow(ServiceUnavailableException);

    describe_.mockRejectedValueOnce(new Error('IA service responded 404'));
    await expect(
      controller.describe({ name: 'A', product: 'B' }, req),
    ).rejects.toThrow(ServiceUnavailableException);
  });
});
