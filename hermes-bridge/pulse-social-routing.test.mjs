import test from 'node:test';
import assert from 'node:assert/strict';
import { dispatchPulseSocial, pulseNeedsExternalLookup } from './pulse-social-routing.mjs';

test('a fictional YouTube content draft does not require Composio', async () => {
  const request = { title: 'Plan de contenido ficticio', prompt: 'Crea un calendario de cinco publicaciones para un canal de YouTube.' };
  const calls = [];
  const result = await dispatchPulseSocial(request, {
    externalLookup: () => calls.push('composio'),
    inference: () => { calls.push('inference'); return 'draft'; },
  });
  assert.equal(result, 'draft');
  assert.deepEqual(calls, ['inference']);
});

test('explicit current YouTube research selects only the read-only lookup', async () => {
  const request = { title: 'Investiga tendencias actuales de YouTube', prompt: 'Devuelve un dato verificable.' };
  const calls = [];
  assert.equal(pulseNeedsExternalLookup(request), true);
  const result = await dispatchPulseSocial(request, {
    externalLookup: () => { calls.push('composio'); return 'lookup'; },
    inference: () => { calls.push('inference'); return 'draft'; },
  });
  assert.equal(result, 'lookup');
  assert.deepEqual(calls, ['composio']);
});

test('an explicit no-sources instruction prevents an external lookup', async () => {
  const request = { prompt: 'No busques en YouTube; redacta un borrador ficticio.' };
  assert.equal(pulseNeedsExternalLookup(request), false);
  const calls = [];
  await dispatchPulseSocial(request, {
    externalLookup: () => calls.push('composio'),
    inference: () => calls.push('inference'),
  });
  assert.deepEqual(calls, ['inference']);
});

test('ambiguous strategy requests default to privacy-routed inference', async () => {
  assert.equal(pulseNeedsExternalLookup({ prompt: 'Propón tres ideas de contenido.' }), false);
});

test('reviewing supplied scripts or drafts for YouTube never invokes Composio', async () => {
  const requests = [
    { prompt: 'Revisa el borrador de mi video de YouTube y mejora el gancho.' },
    { prompt: 'Compara estos dos guiones para YouTube y resume sus fortalezas.' },
    { prompt: 'Prepara un reporte usando solo los datos que te proporciono.' },
  ];
  for (const request of requests) {
    assert.equal(pulseNeedsExternalLookup(request), false, request.prompt);
    const calls = [];
    await dispatchPulseSocial(request, {
      externalLookup: () => calls.push('composio'),
      inference: () => calls.push('inference'),
    });
    assert.deepEqual(calls, ['inference'], request.prompt);
  }
});

test('explicit current public-source requests still select lookup', () => {
  for (const prompt of [
    'Investiga tendencias actuales de YouTube.',
    'Busca canales públicos de tecnología en YouTube.',
    'Compara las métricas públicas de estos canales.',
    'Monitorea estadísticas recientes de publicaciones sociales.',
  ]) {
    assert.equal(pulseNeedsExternalLookup({ prompt }), true, prompt);
  }
});
