// Network discovery: pure helpers plus a two-node HTTP round trip.
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeNode, resetTmp } from './helpers.mjs';
import { createInboundToken } from '../src/config.mjs';
import {
  NETWORK_DEFAULTS,
  mergeNode,
  nodeFromInfo,
  nodeKey,
  normalizeNetworkOptions,
  normalizeNodeUrl,
  scanNetwork,
  selfNetworkNode
} from '../src/network.mjs';

const CFG = {
  name: 'nodeA',
  nodeId: 'node_a',
  publicUrl: null,
  version: 1,
  dsh: { enabled: true, exposeWorkspaces: true, exposeTranscripts: true },
  capabilities: { enabled: true, methods: ['sessions.list'] },
  peers: [{ name: 'nodeB', url: 'http://127.0.0.1:1111/', token: 'peer-secret' }]
};

test('network: options are clamped to safe ranges', () => {
  assert.deepEqual(normalizeNetworkOptions({}), NETWORK_DEFAULTS);
  const wide = normalizeNetworkOptions({ depth: 99, maxNodes: 999, timeoutMs: 1 });
  assert.equal(wide.depth, 3);
  assert.equal(wide.maxNodes, 50);
  assert.equal(wide.timeoutMs, 200);
  const narrow = normalizeNetworkOptions({ depth: 0, maxNodes: 0 });
  assert.equal(narrow.depth, 1);
  assert.equal(narrow.maxNodes, 1);
  assert.deepEqual(normalizeNetworkOptions(null), NETWORK_DEFAULTS);
});

test('network: URLs and node keys are normalized for de-duplication', () => {
  assert.equal(normalizeNodeUrl('HTTP://Example.COM:8787/'), 'http://example.com:8787');
  assert.equal(normalizeNodeUrl(''), null);
  assert.equal(nodeKey({ nodeId: 'NODE_A' }), 'id:node_a');
  assert.equal(nodeKey({ url: 'http://Example.com:8787/' }), 'url:http://example.com:8787');
  assert.equal(nodeKey({ name: 'Node A' }), 'name:node a');
  assert.equal(nodeKey({}), null);
});

test('network: no token or hasToken field ever leaves the node', () => {
  const self = selfNetworkNode(CFG);
  assert.equal(self.self, true);
  assert.equal(self.reachable, true);
  assert.equal(self.directPeers[0].name, 'nodeB');
  assert.equal('token' in self.directPeers[0], false);
  assert.equal('token' in self, false);

  const fromInfo = nodeFromInfo({
    name: 'nodeB',
    nodeId: 'node_b',
    publicUrl: null,
    peers: [{ name: 'nodeA', url: 'http://a', hasToken: true }],
    token: 'leaked'
  }, CFG.peers[0], 12);
  assert.equal(fromInfo.url, 'http://127.0.0.1:1111');
  assert.equal(fromInfo.latencyMs, 12);
  assert.equal('token' in fromInfo, false);
  assert.equal('hasToken' in fromInfo.directPeers[0], false);
});

test('network: mergeNode joins duplicate ids/URLs and unions peers', () => {
  const table = new Map();
  mergeNode(table, { name: 'B', nodeId: 'node_b', url: 'http://b', reachable: false, error: 'offline', directPeers: [] });
  mergeNode(table, {
    name: 'B', nodeId: 'node_b', url: 'http://b/', reachable: true, latencyMs: 5,
    directPeers: [{ name: 'C', url: 'http://c' }], via: ['A']
  });
  assert.equal(table.size, 1);
  const node = [...table.values()][0];
  assert.equal(node.reachable, true);
  assert.equal(node.latencyMs, 5);
  assert.deepEqual(node.directPeers, [{ name: 'C', url: 'http://c' }]);
  assert.deepEqual(node.via, ['A']);
});

test('network: scan walks direct peers and merges a deeper peer', async () => {
  const calls = [];
  const clientFor = (name) => {
    calls.push(name);
    if (name === 'nodeB') {
      return {
        info: async () => ({
          name: 'nodeB', nodeId: 'node_b', publicUrl: null, version: 1,
          dsh: { enabled: true, workspaces: true, transcripts: true },
          capabilities: { enabled: false, methods: [] },
          peers: [{ name: 'nodeC', url: 'http://127.0.0.1:2222', hasToken: true }]
        }),
        networkNodes: async (query) => {
          assert.equal(query.depth, 1);
          return {
            nodes: [{
              name: 'nodeC', nodeId: 'node_c', url: 'http://127.0.0.1:2222', reachable: true,
              self: false, softwareVersion: '0.7.0', dsh: { enabled: true }, capabilities: { enabled: true, methods: ['sessions.list'] }
            }],
            partial: false,
            errors: []
          };
        }
      };
    }
    throw new Error('no token');
  };
  const result = await scanNetwork({
    cfg: {
      ...CFG,
      peers: [
        { name: 'nodeB', url: 'http://127.0.0.1:1111', token: 'tb' },
        { name: 'nodeD', url: 'http://127.0.0.1:4444', token: null }
      ]
    },
    clientFor,
    options: { depth: 2 }
  });
  assert.equal(result.count, 4);
  assert.equal(result.nodes[0].self, true);
  const byName = Object.fromEntries(result.nodes.map((n) => [n.name, n]));
  assert.equal(byName.nodeB.reachable, true);
  assert.equal(byName.nodeC.reachable, true);
  assert.deepEqual(byName.nodeC.via, ['nodeB']);
  assert.equal(byName.nodeD.reachable, false);
  assert.match(byName.nodeD.error, /no token/);
  assert.equal(result.partial, false);
  assert.equal(result.errors.length, 1);
  assert.equal(JSON.stringify(result).includes('peer-secret'), false);
  assert.deepEqual(calls.sort(), ['nodeB', 'nodeD']);
});

test('network: depth 1 does not call networkNodes and maxNodes truncates', async () => {
  let networkCalls = 0;
  const clientFor = () => ({
    info: async () => ({ name: 'nodeB', nodeId: 'node_b', peers: [] }),
    networkNodes: async () => { networkCalls += 1; return { nodes: [], errors: [] }; }
  });
  const depthOne = await scanNetwork({ cfg: CFG, clientFor, options: { depth: 1, maxNodes: 5 } });
  assert.equal(networkCalls, 0);
  assert.equal(depthOne.count, 2);
  assert.equal(depthOne.partial, false);

  const limited = await scanNetwork({ cfg: CFG, clientFor, options: { depth: 1, maxNodes: 1 } });
  assert.equal(limited.count, 1);
  assert.equal(limited.truncated, true);
  assert.equal(limited.partial, true);
});

test('network: HTTP endpoint lists peers and stays closed to anonymous callers', async (t) => {
  await resetTmp();
  const a = await makeNode({ name: 'netA', trustLocalhost: false });
  const b = await makeNode({ name: 'netB' });
  a.connectTo(b);
  b.connectTo(a);
  t.after(async () => { await a.close(); await b.close(); });

  const response = await fetch(a.url + '/api/v1/network/nodes?depth=2', {
    headers: { authorization: 'Bearer ' + a.token }
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.nodes[0].self, true);
  assert.equal(body.count, 2);
  assert.deepEqual(body.nodes.map((n) => n.name).sort(), ['netA', 'netB']);
  assert.equal(body.nodes.find((n) => n.name === 'netB').reachable, true);
  assert.equal(JSON.stringify(body).includes(b.token), false);

  const device = createInboundToken(a.cfg, 'phone-test', { role: 'device' });
  const dev = await fetch(a.url + '/api/v1/network/nodes', {
    headers: { authorization: 'Bearer ' + device.token }
  });
  assert.equal(dev.status, 200);
  const peers = await fetch(a.url + '/api/v1/peers', {
    headers: { authorization: 'Bearer ' + device.token }
  });
  assert.equal(peers.status, 403);
  assert.equal((await peers.json()).error.code, 'role_forbidden');

  const anonymous = await fetch(a.url + '/api/v1/network/nodes');
  assert.equal(anonymous.status, 401);
  const anonymousInfo = await anonymous.json();
  assert.equal(anonymousInfo.error.code, 'unauthorized');
});
test('network: a device token can read and command a remote node DSH surface', async (t) => {
  await resetTmp();
  const a = await makeNode({ name: 'routeA', trustLocalhost: false });
  const b = await makeNode({
    name: 'routeB',
    capabilities: { enabled: true, methods: ['sessions.list'] }
  });
  a.connectTo(b);
  t.after(async () => { await a.close(); await b.close(); });
  const device = createInboundToken(a.cfg, 'phone-route', { role: 'device' });
  const headers = { authorization: 'Bearer ' + device.token, 'content-type': 'application/json' };

  const caps = await fetch(a.url + '/api/v1/dsh/capabilities?peer=routeB', { headers });
  assert.equal(caps.status, 200);
  const capsBody = await caps.json();
  assert.equal(capsBody.peer, 'routeB');
  assert.equal(capsBody.enabled, true);
  assert.deepEqual(capsBody.methods, ['sessions.list']);

  const call = await fetch(a.url + '/api/v1/dsh/call', {
    method: 'POST',
    headers,
    body: JSON.stringify({ peer: 'routeB', method: 'sessions.list', params: {}, waitSeconds: 0 })
  });
  assert.equal(call.status, 200);
  const callBody = await call.json();
  assert.equal(callBody.peer, 'routeB');
  assert.equal(callBody.status, 'pending');
  assert.ok(callBody.commandId);
});
