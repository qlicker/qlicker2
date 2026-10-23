import { describe, it, expect } from 'vitest';
import { computeWordFrequencies } from '../../src/utils/wordFrequency.js';

describe('computeWordFrequencies', () => {
  it('returns an empty array for empty input', () => {
    expect(computeWordFrequencies([])).toEqual([]);
    expect(computeWordFrequencies(null)).toEqual([]);
    expect(computeWordFrequencies(undefined)).toEqual([]);
  });

  it('counts words across multiple responses', () => {
    const texts = ['hello world', 'hello again', 'world is great'];
    const result = computeWordFrequencies(texts, []);
    const map = Object.fromEntries(result.map((r) => [r.text, r.count]));
    expect(map.hello).toBe(2);
    expect(map.world).toBe(2);
    expect(map.again).toBe(1);
    expect(map.great).toBe(1);
    expect(map.is).toBe(1);
  });

  it('excludes stop words (case-insensitive)', () => {
    const texts = ['The quick brown fox', 'A fox is fast'];
    const stopWords = ['the', 'a', 'is'];
    const result = computeWordFrequencies(texts, stopWords);
    const words = result.map((r) => r.text);
    expect(words).toContain('fox');
    expect(words).toContain('quick');
    expect(words).not.toContain('the');
    expect(words).not.toContain('a');
    expect(words).not.toContain('is');
  });

  it('strips HTML tags before tokenizing', () => {
    const texts = ['<p>Hello <strong>world</strong></p>'];
    const result = computeWordFrequencies(texts, []);
    const words = result.map((r) => r.text);
    expect(words).toContain('hello');
    expect(words).toContain('world');
    expect(words).not.toContain('p');
    expect(words).not.toContain('strong');
  });

  it('decodes common HTML entities', () => {
    const texts = ['cats &amp; dogs', 'A &gt; B'];
    const result = computeWordFrequencies(texts, []);
    const words = result.map((r) => r.text);
    expect(words).toContain('cats');
    expect(words).toContain('dogs');
    expect(words).not.toContain('amp');
  });

  it('decodes numeric HTML entities without stripping numbers students actually typed', () => {
    const texts = ['It&#39;s answer 39, not room 101 or h2o.'];
    const result = computeWordFrequencies(texts, []);
    const words = result.map((r) => r.text);
    expect(words).toContain('answer');
    expect(words).toContain('39');
    expect(words).toContain('101');
    expect(words).toContain('room');
    expect(words).toContain('h2o');
  });

  it('ignores single-character tokens', () => {
    const texts = ['I am a fox'];
    const result = computeWordFrequencies(texts, []);
    const words = result.map((r) => r.text);
    expect(words).not.toContain('i');
    expect(words).not.toContain('a');
    expect(words).toContain('am');
    expect(words).toContain('fox');
  });

  it('handles Unicode / accented characters', () => {
    const texts = ['Le café est très bon', 'café noir'];
    const result = computeWordFrequencies(texts, []);
    const map = Object.fromEntries(result.map((r) => [r.text, r.count]));
    expect(map['café']).toBe(2);
    expect(map['est']).toBe(1);
    expect(map['très']).toBe(1);
  });

  it('limits results to maxWords', () => {
    const texts = [Array.from({ length: 200 }, (_, i) => `word${i}`).join(' ')];
    const result = computeWordFrequencies(texts, [], 10);
    expect(result.length).toBe(10);
  });

  it('sorts by count descending, then alphabetically', () => {
    const texts = ['banana apple banana cherry apple apple'];
    const result = computeWordFrequencies(texts, []);
    expect(result[0].text).toBe('apple');
    expect(result[0].count).toBe(3);
    expect(result[1].text).toBe('banana');
    expect(result[1].count).toBe(2);
    expect(result[2].text).toBe('cherry');
    expect(result[2].count).toBe(1);
  });

  it('skips null and non-string entries in the input array', () => {
    const texts = [null, undefined, 42, 'hello world'];
    const result = computeWordFrequencies(texts, []);
    expect(result.length).toBe(2);
    expect(result.map((r) => r.text)).toContain('hello');
    expect(result.map((r) => r.text)).toContain('world');
  });
});
