import test from 'node:test';
import assert from 'node:assert/strict';
import { prependCanonicalOpening, buildEnvelope } from '../src/chat.js';
import { CANONICAL_OPENING, resolveModel, clampEffort, modelEntry } from '../src/constants.js';

test('canonical opening is prepended to an existing system prompt, verbatim merge', () => {
  const msgs = [
    { role: 'system', content: 'You are Claude Code, Anthropic\'s official CLI.' },
    { role: 'user', content: 'hi' },
  ];
  const out = prependCanonicalOpening(msgs);
  assert.equal(out[0].role, 'system');
  assert.equal(out[0].content, CANONICAL_OPENING + '\n\n' + "You are Claude Code, Anthropic's official CLI.");
  // user content untouched
  assert.equal(out[1].content, 'hi');
});

test('canonical opening is NOT duplicated when already present', () => {
  const msgs = [{ role: 'system', content: CANONICAL_OPENING + '\n\ncustom' }];
  const out = prependCanonicalOpening(msgs);
  assert.equal(out[0].content, CANONICAL_OPENING + '\n\ncustom');
  assert.equal(out.length, 1);
});

test('system message is created when none exists; user content untouched', () => {
  const msgs = [{ role: 'user', content: [{ type: 'text', text: 'write code' }] }];
  const out = prependCanonicalOpening(msgs);
  assert.equal(out[0].role, 'system');
  assert.equal(out[0].content, CANONICAL_OPENING);
  assert.deepEqual(out[1].content, [{ type: 'text', text: 'write code' }]);
});

test('array-content system messages keep all parts and only get a leading part', () => {
  const parts = [{ type: 'text', text: 'be nice' }];
  const out = prependCanonicalOpening([{ role: 'system', content: parts }]);
  assert.equal(out[0].content.length, 2);
  assert.equal(out[0].content[0].text, CANONICAL_OPENING);
  assert.deepEqual(out[0].content[1], { type: 'text', text: 'be nice' });
});

test('envelope shape: metadata, provider deny, forced stream, effort', () => {
  const payload = buildEnvelope({
    model: 'z-ai/glm-5.3-flash',
    messages: [{ role: 'user', content: 'hello' }],
    instanceId: 'inst_x',
    reasoning_effort: 'max',
  });
  assert.equal(payload.stream, true);
  assert.deepEqual(payload.provider, { data_collection: 'deny' });
  assert.equal(payload.model, 'z-ai/glm-5.3-flash');
  assert.equal(payload.codebuff_metadata.cost_mode, 'free');
  assert.equal(payload.codebuff_metadata.freebuff_instance_id, 'inst_x');
  assert.equal(payload.codebuff_metadata.llm_step_number, '1');
  assert.equal(payload.codebuff_metadata.freebuff_reasoning_effort, 'max');
  assert.match(payload.codebuff_metadata.run_id, /^[0-9a-f-]{36}$/);
  assert.match(payload.codebuff_metadata.client_id, /^[a-z0-9]{10,15}$/);
  assert.equal(payload.reasoning_effort, 'max');
});

test('envelope: no wallet/limit or evasion fields exist anywhere', () => {
  const payload = buildEnvelope({
    model: 'deepseek/deepseek-v4-flash',
    messages: [{ role: 'system', content: 'You are Hermes Agent, built by Nous Research' }, { role: 'user', content: 'x' }],
    instanceId: 'inst_y',
  });
  // foreign markers must pass through UNTOUCHED — no stripping in this provider
  assert.equal(payload.messages[0].content, CANONICAL_OPENING + '\n\nYou are Hermes Agent, built by Nous Research');
  const s = JSON.stringify(payload);
  assert.ok(!s.includes('sanitiz'));
  assert.ok(!s.includes('claude_code'));
});

test('model resolution: ids and aliases, case-insensitive', () => {
  assert.equal(resolveModel('GLM-5.3-Flash'), 'z-ai/glm-5.3-flash');
  assert.equal(resolveModel('deepseek'), 'deepseek/deepseek-v4-flash');
  assert.equal(resolveModel('deepseek-v4.1-flash'), 'deepseek/deepseek-v4-flash');
  assert.equal(resolveModel('mimo'), 'mimo/mimo-v2.5');
  assert.equal(resolveModel('z-ai/glm-5.3-flash'), 'z-ai/glm-5.3-flash');
  assert.equal(resolveModel('nope-nope'), null);
  assert.equal(resolveModel(undefined), 'z-ai/glm-5.3-flash');
});

test('model resolution: non-string models are REJECTED, not silently defaulted', () => {
  assert.equal(resolveModel(123), null);
  assert.equal(resolveModel({ id: 'glm' }), null);
  assert.equal(resolveModel(true), null);
  // null and empty string still mean "caller has no opinion"
  assert.equal(resolveModel(null), 'z-ai/glm-5.3-flash');
  assert.equal(resolveModel(''), 'z-ai/glm-5.3-flash');
  assert.equal(resolveModel('   '), 'z-ai/glm-5.3-flash');
});

test('clientId shape: exactly 13 base36 chars, no punctuation — always', () => {
  for (let i = 0; i < 500; i++) {
    const payload = buildEnvelope({ model: 'z-ai/glm-5.3-flash', messages: [{ role: 'user', content: 'x' }] });
    assert.match(payload.codebuff_metadata.client_id, /^[a-z0-9]{13}$/);
  }
});

test('prepend is PURE: caller objects are never mutated', () => {
  const original = { role: 'system', content: 'You are Claude Code.' };
  const msgs = [{ ...original }, { role: 'user', content: 'hi' }];
  const out = prependCanonicalOpening(msgs);
  assert.equal(out[0].content, CANONICAL_OPENING + '\n\nYou are Claude Code.');
  // the CALLER's object is untouched
  assert.equal(original.content, 'You are Claude Code.');
  // and the caller's array too
  assert.equal(msgs[0].content, 'You are Claude Code.');
});

test('prepend is IDEMPOTENT across repeated calls on the same output', () => {
  const msgs = [{ role: 'system', content: 'base prompt' }, { role: 'user', content: 'x' }];
  const once1 = prependCanonicalOpening(msgs);
  const twice = prependCanonicalOpening(once1);
  const thrice = prependCanonicalOpening(twice);
  assert.equal(JSON.stringify(twice), JSON.stringify(thrice));
  assert.equal(thrice[0].content.split(CANONICAL_OPENING).length - 1, 1, 'exactly one opening, no duplicates');
});

test('prepend with ARRAY content that already opens with the canonical text does NOT duplicate', () => {
  const msgs = [{
    role: 'system',
    content: [
      { type: 'text', text: CANONICAL_OPENING + '\n\nmy rules' },
      { type: 'text', text: 'more rules' },
    ],
  }];
  const out = prependCanonicalOpening(msgs);
  assert.equal(out[0].content.length, 2, 'no extra part inserted');
  assert.equal(out[0].content[0].text, CANONICAL_OPENING + '\n\nmy rules');
});

test('prepend with array content whose first text part is empty still gets the opening', () => {
  const msgs = [{ role: 'system', content: [{ type: 'text', text: '' }] }];
  const out = prependCanonicalOpening(msgs);
  assert.equal(out[0].content.length, 2);
  assert.equal(out[0].content[0].text, CANONICAL_OPENING);
});

test('prepend with null system content replaces it with the opening', () => {
  const out = prependCanonicalOpening([{ role: 'system', content: null }, { role: 'user', content: 'x' }]);
  assert.equal(out[0].content, CANONICAL_OPENING);
});

test('effort clamping follows the GLM ladder only', () => {
  assert.equal(clampEffort('z-ai/glm-5.3-flash', 'medium'), 'low');
  assert.equal(clampEffort('z-ai/glm-5.3-flash', 'bogus'), 'max');
  assert.equal(clampEffort('z-ai/glm-5.3-flash', 'high'), 'high');
  assert.equal(clampEffort('deepseek/deepseek-v4-flash', 'max'), undefined);
  assert.ok(modelEntry('mimo/mimo-v2.5'));
});
