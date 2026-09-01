import crypto from 'crypto';
import { generateReferralCode } from '@/lib/referrals';

/**
 * Campos base que TODO tenant nuevo tiene que traer, sin importar por dónde
 * entró (signup con email, instalación desde el App Store, reclamo de tienda).
 *
 * POR QUÉ EXISTE
 * --------------
 * El alta desde el App Store nació sin esto y quedó con `apiKey` en el
 * `@default(cuid())` del schema. cuid NO es criptográficamente aleatorio, y
 * apiKey es la credencial de la API pública: dejarlo así es regalar una
 * credencial adivinable a cada tienda que se instala sola. Signup ya usaba
 * `randomBytes(32)` a propósito; ahora lo usan todos desde acá.
 *
 * Lo mismo con `referralCode`: la UI de referidos asume que todo tenant tiene
 * uno. Un tenant sin código rompe la página de referidos del comerciante.
 */
export interface TenantBase {
  apiKey: string;
  referralCode: string | null;
}

/** Lo mínimo que necesitamos del cliente de Prisma (sirve `db` o una `tx`). */
export interface ReferralLookup {
  tenant: {
    findUnique(args: {
      where: { referralCode: string };
      select: { id: true };
    }): Promise<{ id: string } | null>;
  };
}

export function nuevaApiKey(): string {
  return crypto.randomBytes(32).toString('hex');
}

/**
 * Elige un código de referido libre derivado del slug. Igual que en signup:
 * hasta 5 intentos; si los 5 colisionan (espacio de 65k por prefijo, no va a
 * pasar), queda null y el comerciante lo genera después desde la UI.
 */
export async function elegirReferralCode(db: ReferralLookup, baseSlug: string): Promise<string | null> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const candidate = generateReferralCode(baseSlug);
    const collision = await db.tenant.findUnique({
      where: { referralCode: candidate },
      select: { id: true },
    });
    if (!collision) return candidate;
  }
  return null;
}

export async function nuevoTenantBase(db: ReferralLookup, baseSlug: string): Promise<TenantBase> {
  return {
    apiKey: nuevaApiKey(),
    referralCode: await elegirReferralCode(db, baseSlug),
  };
}
