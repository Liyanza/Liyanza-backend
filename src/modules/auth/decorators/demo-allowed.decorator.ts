import { SetMetadata } from '@nestjs/common';

export const DEMO_ALLOWED_KEY = 'demoAllowed';

/**
 * Autorise une route d'écriture (POST/PATCH/PUT/DELETE) pour une session de
 * la démo publique, que `DemoReadOnlyGuard` refuse sinon. Réservé à ce qui
 * ne modifie pas les données de démo partagées par tous les visiteurs ni
 * ne déclenche d'effet externe (e-mail, paiement, liaison de compte) :
 * déconnexion et Copilot.
 */
export const DemoAllowed = () => SetMetadata(DEMO_ALLOWED_KEY, true);
