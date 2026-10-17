import test from 'node:test';
import assert from 'node:assert/strict';
import { tagSubgenres, percentiles, scoreMovies, tierFor, GENRE } from './lib.mjs';

test('tags subgenres from keywords and genres', () => {
  const sg = tagSubgenres(['demonic possession', 'exorcism', 'priest'], [27]);
  assert.ok(sg.includes('possession'));
  assert.ok(sg.includes('demonic'));
  assert.deepEqual(tagSubgenres(['slasher', 'summer camp'], [27, GENRE.thriller]).sort(), ['slasher', 'teen']);
  assert.deepEqual(tagSubgenres(['kidnapping'], [27]), ['terror']);
  assert.deepEqual(tagSubgenres([], [27]), []);
});

test('percentiles handle ties and nulls', () => {
  assert.deepEqual(percentiles([1, null, 3, 3]), [0, null, 75, 75]);
});

test('scores separate a widely seen hit from a quiet new release', () => {
  const today = new Date('2026-10-17T12:00:00Z');
  const movies = [
    { id: 1, pop: 400, votes: 15000, imdbVotes: 600000, weekRank: 2, dayRank: 1, date: '2026-09-20' },
    { id: 2, pop: 3, votes: 12, imdbVotes: 150, weekRank: null, dayRank: null, date: '2026-10-01' },
    { id: 3, pop: 40, votes: 4000, imdbVotes: 90000, weekRank: null, dayRank: null, date: '1980-05-09' },
  ];
  const [hit, quiet, classic] = scoreMovies(movies, today);
  assert.equal(hit.tier, 'fresh');
  assert.ok(hit.flags.includes('hot') && hit.flags.includes('new'));
  assert.equal(quiet.tier, 'fresh');
  assert.equal(classic.tier !== 'fresh', true);
  assert.ok(quiet.flags.includes('quiet'));
  assert.ok(!classic.flags.includes('new'));
  assert.ok(hit.buzz > classic.buzz && classic.buzz > quiet.buzz);
});

test('tier thresholds', () => {
  assert.equal(tierFor(90), 'favorite');
  assert.equal(tierFor(60), 'known');
  assert.equal(tierFor(31), 'cult');
  assert.equal(tierFor(5), 'deep');
});
