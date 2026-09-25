import type { Response } from 'express';

export type SseEmit = (event: object) => void;

/**
 * Exécute `run` en relayant ses événements au client en Server-Sent Events
 * (`data: {...}\n\n`).
 *
 * Le flux n'est ouvert (statut 200 + en-têtes SSE) qu'au PREMIER événement :
 * une erreur levée avant — conversation introuvable, quota atteint, moteur
 * IA indisponible — reste une réponse HTTP ordinaire (404, 429, 503…)
 * produite par le filtre d'exceptions global. Une erreur après l'ouverture
 * ne peut plus changer le statut : elle devient un événement
 * `{ "type": "error" }` et le flux se termine.
 */
export async function streamSse(
  res: Response,
  run: (emit: SseEmit) => Promise<void>,
): Promise<void> {
  let started = false;
  const emit: SseEmit = (event) => {
    if (!started) {
      res.status(200);
      res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
      // no-transform : aucun proxy ne doit compresser (donc mettre en tampon).
      res.setHeader('Cache-Control', 'no-cache, no-transform');
      res.setHeader('X-Accel-Buffering', 'no');
      res.flushHeaders();
      started = true;
    }
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  };

  try {
    await run(emit);
  } catch (error) {
    if (!started) throw error;
    emit({ type: 'error' });
  }
  res.end();
}
