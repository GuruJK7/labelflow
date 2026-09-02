import { describe, it, expect } from 'vitest';
import { codFeatureEnabled } from '../cod-feature';

describe('codFeatureEnabled — fail-closed hasta que Adrian confirme el worker', () => {
  it('sin la var, vacía o con cualquier otro valor → apagado', () => {
    expect(codFeatureEnabled({})).toBe(false);
    expect(codFeatureEnabled({ COD_FEATURE_ENABLED: '' })).toBe(false);
    expect(codFeatureEnabled({ COD_FEATURE_ENABLED: 'false' })).toBe(false);
    expect(codFeatureEnabled({ COD_FEATURE_ENABLED: 'yes' })).toBe(false);
    expect(codFeatureEnabled({ COD_FEATURE_ENABLED: '0' })).toBe(false);
  });
  it('true / 1 (con espacios o mayúsculas) → prendido', () => {
    expect(codFeatureEnabled({ COD_FEATURE_ENABLED: 'true' })).toBe(true);
    expect(codFeatureEnabled({ COD_FEATURE_ENABLED: ' TRUE ' })).toBe(true);
    expect(codFeatureEnabled({ COD_FEATURE_ENABLED: '1' })).toBe(true);
  });
});
