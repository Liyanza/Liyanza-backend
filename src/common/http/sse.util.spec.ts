import { NotFoundException } from '@nestjs/common';
import type { Response } from 'express';
import { streamSse } from './sse.util';

describe('streamSse', () => {
  /** Faux `Response` : les mocks sont testés, l'objet typé est passé. */
  const buildRes = () => {
    const mocks = {
      status: jest.fn(),
      setHeader: jest.fn(),
      flushHeaders: jest.fn(),
      write: jest.fn(),
      end: jest.fn(),
    };
    return Object.assign(mocks, { response: mocks as unknown as Response });
  };

  it('should open the stream on the first event and write each event as SSE', async () => {
    const res = buildRes();

    await streamSse(res.response, (emit) => {
      emit({ type: 'delta', text: 'Bon' });
      emit({ type: 'delta', text: 'jour' });
      emit({ type: 'done' });
      return Promise.resolve();
    });

    expect(res.status).toHaveBeenCalledTimes(1);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.setHeader).toHaveBeenCalledWith(
      'Content-Type',
      'text/event-stream; charset=utf-8',
    );
    expect(res.write.mock.calls.map(([chunk]: [string]) => chunk)).toEqual([
      'data: {"type":"delta","text":"Bon"}\n\n',
      'data: {"type":"delta","text":"jour"}\n\n',
      'data: {"type":"done"}\n\n',
    ]);
    expect(res.end).toHaveBeenCalled();
  });

  it('should rethrow an error raised before any event (normal HTTP error)', async () => {
    const res = buildRes();

    await expect(
      streamSse(res.response, () => Promise.reject(new NotFoundException())),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(res.status).not.toHaveBeenCalled();
    expect(res.write).not.toHaveBeenCalled();
    expect(res.end).not.toHaveBeenCalled();
  });

  it('should turn an error raised mid-stream into an error event', async () => {
    const res = buildRes();

    await streamSse(res.response, (emit) => {
      emit({ type: 'delta', text: 'Bon' });
      return Promise.reject(new Error('IA stream interrupted'));
    });

    expect(res.write).toHaveBeenLastCalledWith('data: {"type":"error"}\n\n');
    expect(res.end).toHaveBeenCalled();
  });
});
