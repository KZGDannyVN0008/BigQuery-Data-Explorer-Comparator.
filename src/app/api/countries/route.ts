import { fail, ok } from '@/lib/api';
import { listCountries } from '@/lib/services/countries';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    return ok(await listCountries());
  } catch (error) {
    return fail(error);
  }
}
