/**
 * Unit tests for invokeClaudeForAddressCorrection().
 *
 * Mocks child_process.spawn and fs so no real Claude binary, no /tmp writes,
 * and no external services are involved. Each test controls what the mock
 * "claude" process writes to the result file and when it exits.
 *
 * Test inventory:
 *   1. Happy path           — Claude returns valid override → function returns it
 *   2. Claude can't fix     — success:false → returns null
 *   3. Timeout              — process doesn't close in time → returns null
 *   4. No result file       — readFile throws ENOENT → returns null, no crash
 *   5. Malformed JSON       — readFile returns garbage → returns null, no crash
 *   6. Partial override     — only department in override → returned as-is
 *   7. Security regression  — context file must NOT contain DAC credentials
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';

// ─── module mocks (hoisted before any imports) ───────────────────────────────

vi.mock('child_process', () => ({ spawn: vi.fn() }));

vi.mock('fs', () => ({
  promises: {
    unlink: vi.fn().mockResolvedValue(undefined),
    writeFile: vi.fn().mockResolvedValue(undefined),
    rename: vi.fn().mockResolvedValue(undefined),
    readFile: vi.fn(),
  },
}));

// ─── imports (after mocks) ───────────────────────────────────────────────────

import { spawn } from 'child_process';
import { promises as fsMock } from 'fs';
import { invokeClaudeForAddressCorrection } from '../agent/invoke-claude';

// ─── helpers ─────────────────────────────────────────────────────────────────

/** Create a fake child process that behaves like the real spawn() return value. */
function createMockChild() {
  const child = new EventEmitter() as any;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = vi.fn();
  return child;
}

/** Minimal fake AgentJobPayload entry for a YELLOW order. */
const fakeEntry: any = {
  order: {
    id: 9001,
    name: '#1001',
    shipping_address: {
      first_name: 'Juan',
      last_name: 'Pérez',
      address1: 'Canelones 500, Apto 3',
      address2: '',
      city: 'Las Piedras',
      province: 'Montevideo', // intentionally wrong for a YELLOW order
      zip: '',
      phone: '099111222',
      country: 'Uruguay',
    },
  },
  classification: {
    zone: 'YELLOW',
    reasons: ['UNKNOWN_CITY'],
    summary: 'Ambiguous but shippable: UNKNOWN_CITY',
    orderId: '9001',
    orderName: '#1001',
  },
  labelId: 'test-label-id-001',
  paymentType: 'DESTINATARIO',
};

/** No-op step logger that satisfies the StepLogger interface. */
const noopSlog: any = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  success: vi.fn(),
};

const ADDRESS_RESULT_PATH = '/tmp/labelflow-addr-result.json';
const ADDRESS_CONTEXT_PATH = '/tmp/labelflow-addr-context.json';

// ─── setup ───────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  // Default: unlink, writeFile, rename succeed silently
  (fsMock.unlink as any).mockResolvedValue(undefined);
  (fsMock.writeFile as any).mockResolvedValue(undefined);
  (fsMock.rename as any).mockResolvedValue(undefined);
});

// ─── tests ───────────────────────────────────────────────────────────────────

describe('invokeClaudeForAddressCorrection — happy path', () => {
  it('1. Claude returns valid override → function returns the AddressOverride object', async () => {
    const mockChild = createMockChild();
    (spawn as any).mockReturnValue(mockChild);

    // Claude writes this to the result file before exiting
    (fsMock.readFile as any).mockResolvedValue(
      JSON.stringify({
        success: true,
        override: { department: 'Canelones', city: 'Las Piedras' },
        reasoning: 'city "Las Piedras" maps to department Canelones',
      }),
    );

    const promise = invokeClaudeForAddressCorrection({
      entry: fakeEntry,
      jobId: 'job-001',
      slog: noopSlog,
    });

    // Simulate the claude process exiting cleanly
    process.nextTick(() => mockChild.emit('close', 0));

    const result = await promise;

    expect(result).toEqual({ department: 'Canelones', city: 'Las Piedras' });
  });
});

describe('invokeClaudeForAddressCorrection — failure paths', () => {
  it('2. Claude returns success:false → returns null', async () => {
    const mockChild = createMockChild();
    (spawn as any).mockReturnValue(mockChild);

    (fsMock.readFile as any).mockResolvedValue(
      JSON.stringify({
        success: false,
        reasoning: 'cannot determine department for city "xyz"',
      }),
    );

    const promise = invokeClaudeForAddressCorrection({
      entry: fakeEntry,
      jobId: 'job-002',
      slog: noopSlog,
    });

    process.nextTick(() => mockChild.emit('close', 1));

    const result = await promise;
    expect(result).toBeNull();
  });

  it('4. No result file written (ENOENT) → returns null, does not crash', async () => {
    const mockChild = createMockChild();
    (spawn as any).mockReturnValue(mockChild);

    const enoentError = Object.assign(new Error('ENOENT: no such file or directory'), {
      code: 'ENOENT',
    });
    (fsMock.readFile as any).mockRejectedValue(enoentError);

    const promise = invokeClaudeForAddressCorrection({
      entry: fakeEntry,
      jobId: 'job-004',
      slog: noopSlog,
    });

    process.nextTick(() => mockChild.emit('close', 1));

    const result = await promise;
    expect(result).toBeNull();
    // Should log a warning, not throw
    expect(noopSlog.warn).toHaveBeenCalled();
  });

  it('5. Result file contains malformed JSON → returns null, does not crash', async () => {
    const mockChild = createMockChild();
    (spawn as any).mockReturnValue(mockChild);

    (fsMock.readFile as any).mockResolvedValue('{ this is not valid json !!!');

    const promise = invokeClaudeForAddressCorrection({
      entry: fakeEntry,
      jobId: 'job-005',
      slog: noopSlog,
    });

    process.nextTick(() => mockChild.emit('close', 0));

    const result = await promise;
    expect(result).toBeNull();
  });
});

describe('invokeClaudeForAddressCorrection — timeout', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('3. Process does not exit within timeoutMs → kill sent, returns null', async () => {
    const mockChild = createMockChild();
    (spawn as any).mockReturnValue(mockChild);

    // Make kill() cause the child to emit 'close' (as a real OS would do)
    mockChild.kill.mockImplementation(() => {
      process.nextTick(() => mockChild.emit('close', null));
    });

    // readFile should not be called (process was killed before writing result)
    (fsMock.readFile as any).mockRejectedValue(new Error('ENOENT'));

    const promise = invokeClaudeForAddressCorrection({
      entry: fakeEntry,
      jobId: 'job-003',
      slog: noopSlog,
      timeoutMs: 100,
    });

    // Advance fake time past the 100ms timeout
    await vi.advanceTimersByTimeAsync(200);

    const result = await promise;

    expect(result).toBeNull();
    expect(mockChild.kill).toHaveBeenCalledWith('SIGTERM');
    expect(noopSlog.error).toHaveBeenCalledWith(
      'addr-correction-timeout',
      expect.stringContaining('100ms'),
    );
  });
});

describe('invokeClaudeForAddressCorrection — partial override', () => {
  it('6. Claude returns only department in override → { department } returned as-is', async () => {
    const mockChild = createMockChild();
    (spawn as any).mockReturnValue(mockChild);

    (fsMock.readFile as any).mockResolvedValue(
      JSON.stringify({
        success: true,
        override: { department: 'Maldonado' },
        reasoning: 'province override only, city kept from Shopify',
      }),
    );

    const promise = invokeClaudeForAddressCorrection({
      entry: fakeEntry,
      jobId: 'job-006',
      slog: noopSlog,
    });

    process.nextTick(() => mockChild.emit('close', 0));

    const result = await promise;

    // Should return exactly what Claude provided — no extra fields added
    expect(result).toEqual({ department: 'Maldonado' });
    expect(result).not.toHaveProperty('city');
    expect(result).not.toHaveProperty('address1');
  });
});

describe('invokeClaudeForAddressCorrection — security regression', () => {
  it('7. Context file written to disk must NOT contain DAC credentials', async () => {
    const mockChild = createMockChild();
    (spawn as any).mockReturnValue(mockChild);

    (fsMock.readFile as any).mockResolvedValue(
      JSON.stringify({ success: true, override: { department: 'Canelones' } }),
    );

    const promise = invokeClaudeForAddressCorrection({
      entry: fakeEntry,
      jobId: 'job-007',
      slog: noopSlog,
    });

    process.nextTick(() => mockChild.emit('close', 0));
    await promise;

    // Find the writeFile call for the context .tmp file
    const writeCalls: any[] = (fsMock.writeFile as any).mock.calls;
    const contextWriteCall = writeCalls.find(([path]: [string]) =>
      path.includes('addr-context'),
    );

    expect(contextWriteCall, 'writeFile should have been called with context path').toBeTruthy();

    const writtenContent = contextWriteCall[1] as string;
    const context = JSON.parse(writtenContent);

    // DAC credentials must never appear in the context file
    expect(context).not.toHaveProperty('dacUsername');
    expect(context).not.toHaveProperty('dacPassword');
    expect(context).not.toHaveProperty('DAC_USERNAME');
    expect(context).not.toHaveProperty('DAC_PASSWORD');
    expect(context).not.toHaveProperty('dacCreds');

    // Context must contain the address (what Claude actually needs)
    expect(context).toHaveProperty('shipping_address');
    expect(context).toHaveProperty('validDepartments');
    expect(context).toHaveProperty('classificationReasons');

    // File must be written with 0600 permissions (owner-only readable)
    const writeOptions = contextWriteCall[2] as { mode?: number; encoding?: string };
    expect(writeOptions?.mode).toBe(0o600);
  });

  it('7b. Cleanup: both context and result files are unlinked after the call', async () => {
    const mockChild = createMockChild();
    (spawn as any).mockReturnValue(mockChild);

    (fsMock.readFile as any).mockResolvedValue(
      JSON.stringify({ success: true, override: { department: 'Rocha' } }),
    );

    const promise = invokeClaudeForAddressCorrection({
      entry: fakeEntry,
      jobId: 'job-007b',
      slog: noopSlog,
    });

    process.nextTick(() => mockChild.emit('close', 0));
    await promise;

    const unlinkPaths = (fsMock.unlink as any).mock.calls.map(([p]: [string]) => p);
    expect(unlinkPaths).toContain(ADDRESS_CONTEXT_PATH);
    expect(unlinkPaths).toContain(ADDRESS_RESULT_PATH);
  });
});

describe('invokeClaudeForAddressCorrection — spawn arguments', () => {
  it('Claude is invoked with Read,Write tools only (no Playwright)', async () => {
    const mockChild = createMockChild();
    (spawn as any).mockReturnValue(mockChild);

    (fsMock.readFile as any).mockResolvedValue(
      JSON.stringify({ success: true, override: { department: 'Flores' } }),
    );

    const promise = invokeClaudeForAddressCorrection({
      entry: fakeEntry,
      jobId: 'job-spawn',
      slog: noopSlog,
    });

    process.nextTick(() => mockChild.emit('close', 0));
    await promise;

    const [_bin, args] = (spawn as any).mock.calls[0] as [string, string[]];

    // Must include allowed-tools
    const toolsIdx = args.indexOf('--allowed-tools');
    expect(toolsIdx).toBeGreaterThan(-1);
    const tools = args[toolsIdx + 1];
    expect(tools).toContain('Read');
    expect(tools).toContain('Write');
    // Must NOT have Playwright tools
    expect(tools).not.toContain('playwright');
    expect(tools).not.toContain('browser_navigate');

    // Must use haiku (fast, cheap text reasoning)
    const modelIdx = args.indexOf('--model');
    expect(modelIdx).toBeGreaterThan(-1);
    expect(args[modelIdx + 1]).toBe('haiku');

    // Must use -p (print mode, non-interactive)
    expect(args).toContain('-p');
  });
});
