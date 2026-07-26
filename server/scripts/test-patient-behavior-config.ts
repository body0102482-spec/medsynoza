/**
 * Regression: stationConfig patientBehavior parse/merge/serialize + prompt injection.
 * Run: npx tsx scripts/test-patient-behavior-config.ts
 */
import assert from 'node:assert/strict';
import {
  DEFAULT_PATIENT_BEHAVIOR,
  formatPatientBehaviorPrompt,
  mergeStationConfig,
  parseStationConfig,
  serializePartialStationConfig,
  serializeStationConfig,
  parsePartialStationConfig,
} from '../src/lib/stationConfig.js';

function section(title: string) {
  console.log(`\n── ${title}`);
}

section('parse empty → defaults');
{
  const cfg = parseStationConfig(null);
  assert.deepEqual(cfg.patientBehavior, DEFAULT_PATIENT_BEHAVIOR);
}

section('parse legacy JSON without patientBehavior');
{
  const cfg = parseStationConfig(
    JSON.stringify({
      enabledManeuvers: ['inspection'],
      enableHistoryExaminer: false,
    }),
  );
  assert.equal(cfg.enabledManeuvers.length, 1);
  assert.equal(cfg.enableHistoryExaminer, false);
  assert.deepEqual(cfg.patientBehavior, DEFAULT_PATIENT_BEHAVIOR);
}

section('parse + serialize round-trip with behavior');
{
  const raw = serializeStationConfig({
    ...parseStationConfig(null),
    patientBehavior: {
      instructions: 'Speak slowly and ask for clarification once.',
      tone: 'guarded',
      emotion: 'anxious',
      preferredLanguage: 'AR',
      constraints: 'Never mention cancer.',
    },
  });
  const cfg = parseStationConfig(raw);
  assert.equal(cfg.patientBehavior.tone, 'guarded');
  assert.equal(cfg.patientBehavior.emotion, 'anxious');
  assert.equal(cfg.patientBehavior.preferredLanguage, 'AR');
  assert.match(cfg.patientBehavior.instructions, /Speak slowly/);
  assert.match(cfg.patientBehavior.constraints, /cancer/);
}

section('university override deep-merges patientBehavior');
{
  const base = parseStationConfig(
    serializeStationConfig({
      ...parseStationConfig(null),
      patientBehavior: {
        instructions: 'Base instructions',
        tone: 'calm',
        emotion: 'worried',
        preferredLanguage: 'AUTO',
        constraints: 'Base constraint',
      },
    }),
  );
  const override = parsePartialStationConfig(
    serializePartialStationConfig({
      patientBehavior: {
        tone: 'irritable',
        preferredLanguage: 'EN',
      },
    }),
  );
  const merged = mergeStationConfig(base, override);
  assert.equal(merged.patientBehavior.tone, 'irritable');
  assert.equal(merged.patientBehavior.preferredLanguage, 'EN');
  assert.equal(merged.patientBehavior.emotion, 'worried');
  assert.equal(merged.patientBehavior.instructions, 'Base instructions');
  assert.equal(merged.patientBehavior.constraints, 'Base constraint');
}

section('formatPatientBehaviorPrompt');
{
  const empty = formatPatientBehaviorPrompt(DEFAULT_PATIENT_BEHAVIOR);
  assert.equal(empty, '');

  const block = formatPatientBehaviorPrompt({
    instructions: 'Use short answers.',
    tone: 'cooperative',
    emotion: 'fearful',
    preferredLanguage: 'AR',
    constraints: 'Do not invent family history.',
  });
  assert.match(block, /STATION PATIENT BEHAVIOR/);
  assert.match(block, /Tone: cooperative/);
  assert.match(block, /Emotion: fearful/);
  assert.match(block, /Preferred language: AR/);
  assert.match(block, /Use short answers/);
  assert.match(block, /family history/);
}

console.log('\n✅ patientBehavior stationConfig tests passed');
