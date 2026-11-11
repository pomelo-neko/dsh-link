import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { PROJECT_DIR } from './helpers.mjs';
import { DSHLINK_VERSION } from '../src/util.mjs';

const SKILL_FILE = path.join(PROJECT_DIR, 'integrations', 'dsh-skill', 'SKILL.md');

const readSkill = () => fs.readFile(SKILL_FILE, 'utf8');

test('dsh-skill: the bundled SKILL.md documents the current release line and the agent-facing surface', async () => {
  const text = await readSkill();
  assert.match(text, /^---\r?\nname: dshlink\r?\n/, 'front matter keeps the skill name');
  assert.match(text, /\$ROOT\\bin\\dshlink\.mjs/, 'commands go through the portable $ROOT placeholder, never a machine path');
  const [major, minor] = DSHLINK_VERSION.split('.');
  const releaseLine = major + '.' + minor + '.x';
  assert.ok(text.includes(releaseLine), 'SKILL.md should name the release line it documents (' + releaseLine + ') — refresh it when the line moves');
  const needles = [
    '--target-session', '--origin-session', 'bind --thread',
    'dsh transcript', 'dsh sessions', 'dsh capabilities',
    'hub invite --phone', 'hub phone bootstrap', 'hub phone devices', 'hub phone revoke',
    'hub-service.ps1', 'docs/PHONE-SECURITY.md',
    'install-dsh --write', 'link_send_message', 'link_reply', 'state.json'
  ];
  for (const needle of needles) assert.ok(text.includes(needle), 'SKILL.md lost coverage of: ' + needle);
});

test('dsh-skill: the bundled SKILL.md carries no machine-specific values', async () => {
  const text = await readSkill();
  const patterns = [
    /DESKTOP-/, /LAPTOP-/, /C:\\Users\\/, /D:\\DeepSeekHarness/, /192\.168\./, /127\.0\.0\.1/,
    /121\.43\./, /dshlink-frp/, /tok_[A-Za-z0-9]{6,}/
  ];
  for (const pattern of patterns) {
    assert.doesNotMatch(text, pattern, 'machine-specific value in the bundled skill: ' + pattern);
  }
});

test('dsh-skill: every documented CLI command exists', async () => {
  const [text, cli] = await Promise.all([readSkill(), fs.readFile(path.join(PROJECT_DIR, 'bin', 'dshlink.mjs'), 'utf8')]);
  const block = cli.match(/const COMMANDS = \{([\s\S]*?)\n\};/);
  assert.ok(block, 'the CLI command registry moved — update this test');
  const commands = new Set();
  for (const match of block[1].matchAll(/'([a-z][a-z-]*)'|([a-z][a-z-]*)\s*:/g)) commands.add(match[1] ?? match[2]);
  const documented = new Set();
  for (const match of text.matchAll(/dshlink\.mjs"?\s+([a-z][a-z-]*)/g)) documented.add(match[1]);
  assert.ok(documented.size >= 8, 'expected the skill to document several CLI commands, found ' + documented.size);
  for (const command of documented) assert.ok(commands.has(command), 'SKILL.md documents a command the CLI does not have: ' + command);
});
