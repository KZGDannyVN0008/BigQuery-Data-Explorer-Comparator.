import { describe, expect, it } from 'vitest';
import {
  coreTokens,
  countryPrefix,
  nameSimilarity,
  rankCandidates,
  scoreCandidate,
  suggestKeyColumns,
  type CandidateColumns,
} from '@/lib/similarity';

const source: CandidateColumns = {
  ref: { project: 'kz-dp-prod', dataset: 'dpp_gold_prod', table: 'ph_dpp_deposit_v2_gold' },
  columns: [
    { name: 'transaction_id', type: 'STRING' },
    { name: 'merchant', type: 'STRING' },
    { name: 'country', type: 'STRING' },
    { name: 'amount', type: 'NUMERIC' },
    { name: 'status', type: 'STRING' },
    { name: 'channel', type: 'STRING' },
  ],
};

const goodMatch: CandidateColumns = {
  ref: { project: 'kz-kura', dataset: 'kura_gold', table: 'ph_deposit_v2' },
  columns: [
    { name: 'transaction_id', type: 'STRING' },
    { name: 'merchant', type: 'STRING' },
    { name: 'country', type: 'STRING' },
    { name: 'amount', type: 'FLOAT64' },
    { name: 'status', type: 'STRING' },
  ],
};

const wrongCountry: CandidateColumns = {
  ref: { project: 'kz-kura', dataset: 'kura_gold', table: 'bd_deposit_v2' },
  columns: goodMatch.columns,
};

const unrelated: CandidateColumns = {
  ref: { project: 'kz-kura', dataset: 'kura_gold', table: 'merchant_master' },
  columns: [
    { name: 'merchant', type: 'STRING' },
    { name: 'merchant_name', type: 'STRING' },
    { name: 'is_active', type: 'BOOL' },
  ],
};

describe('country prefix detection', () => {
  it('reads the leading two-letter code', () => {
    expect(countryPrefix('ph_dpp_deposit_v2_gold')).toBe('PH');
    expect(countryPrefix('bd_deposit_v2')).toBe('BD');
  });

  it('returns null when the prefix is not a known country', () => {
    expect(countryPrefix('xx_deposit')).toBeNull();
    expect(countryPrefix('deposit_transaction_consolidated')).toBeNull();
  });
});

describe('name similarity', () => {
  it('strips country prefixes and environment noise', () => {
    expect(coreTokens('ph_dpp_deposit_v2_gold')).toEqual(['dpp', 'deposit']);
  });

  it('scores the matching pair above the unrelated pair', () => {
    const good = nameSimilarity('ph_dpp_deposit_v2_gold', 'ph_deposit_v2');
    const bad = nameSimilarity('ph_dpp_deposit_v2_gold', 'merchant_master');
    expect(good).toBeGreaterThan(bad);
    expect(good).toBeGreaterThan(0.4);
  });
});

describe('scoreCandidate', () => {
  it('rewards a same-country, high-overlap candidate', () => {
    const score = scoreCandidate(source, goodMatch);
    expect(score.countryPrefix).toBe('PH');
    expect(score.sharedColumns).toEqual(['amount', 'country', 'merchant', 'status', 'transaction_id']);
    // amount is NUMERIC on one side and FLOAT64 on the other.
    expect(score.typeMatchRatio).toBeCloseTo(4 / 5, 5);
    expect(score.score).toBeGreaterThan(0.6);
  });

  it('penalises a different country prefix even with identical columns', () => {
    expect(scoreCandidate(source, goodMatch).score).toBeGreaterThan(
      scoreCandidate(source, wrongCountry).score,
    );
  });

  it('explains itself', () => {
    const reasons = scoreCandidate(source, goodMatch).reasons.join(' ');
    expect(reasons).toContain('Same country prefix');
    expect(reasons).toContain('shared columns');
  });
});

describe('rankCandidates', () => {
  it('ranks the true counterpart first and drops weak matches', () => {
    const ranked = rankCandidates(source, [unrelated, wrongCountry, goodMatch]);
    expect(ranked[0].ref.table).toBe('ph_deposit_v2');
    expect(ranked.map((r) => r.ref.table)).not.toContain('unrelated');
  });

  it('never suggests the source table itself', () => {
    expect(rankCandidates(source, [source]).length).toBe(0);
  });
});

describe('suggestKeyColumns', () => {
  it('ranks identifier-shaped columns above descriptive ones', () => {
    const ranked = suggestKeyColumns([
      { name: 'status', leftType: 'STRING', rightType: 'STRING' },
      { name: 'transaction_id', leftType: 'STRING', rightType: 'STRING' },
      { name: 'merchant', leftType: 'STRING', rightType: 'STRING' },
    ]);
    expect(ranked[0].name).toBe('transaction_id');
    expect(ranked.at(-1)?.name).toBe('status');
  });
});
