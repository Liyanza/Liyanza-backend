import { PartialType } from '@nestjs/swagger';
import { CreateCampagneDto } from './create-campagne.dto';

export class UpdateCampagneDto extends PartialType(CreateCampagneDto) {}
