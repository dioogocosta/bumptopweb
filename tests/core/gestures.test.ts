/**
 * Testes do FSM de gestos (M5) — máquina de estados pura.
 * Espelha a classificação de intenção do BT_GestureManager.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { GestureFSM, type GestureEvent } from '../../src/core/interaction/gestureFsm';

const pt = (x: number, y: number, t = 0) => ({ x, y, screenX: x, screenY: y, time: t });

function collect(fsm: GestureFSM): GestureEvent[] {
  const events: GestureEvent[] = [];
  fsm.on((e) => events.push(e));
  return events;
}

describe('GestureFSM', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('tap simples (sem movimento) emite tap', () => {
    const fsm = new GestureFSM();
    const events = collect(fsm);
    fsm.press(pt(10, 10), 'floor', 0);
    fsm.release(pt(10, 10), 100);
    expect(events.map((e) => e.type)).toEqual(['tap']);
    expect(fsm.getState()).toBe('idle');
  });

  it('dois taps rápidos emitem doubleTap', () => {
    const fsm = new GestureFSM();
    const events = collect(fsm);
    fsm.press(pt(10, 10), 'floor', 0);
    fsm.release(pt(10, 10), 100);
    fsm.press(pt(10, 10), 'floor', 200);
    fsm.release(pt(10, 10), 250);
    expect(events.map((e) => e.type)).toEqual(['tap', 'doubleTap']);
  });

  it('movimento além do slop sobre objeto → dragStart/dragMove/dragEnd', () => {
    const fsm = new GestureFSM();
    const events = collect(fsm);
    fsm.press(pt(0, 0), 'object', 0);
    fsm.move(pt(5, 5), 16); // ainda dentro do slop (8px)
    expect(events).toHaveLength(0);
    fsm.move(pt(50, 0), 32); // passou do slop → dragStart (frame de transição)
    fsm.move(pt(80, 0), 48); // dragMove
    fsm.release(pt(80, 0), 60);
    expect(events.map((e) => e.type)).toEqual(['dragStart', 'dragMove', 'dragEnd']);
    const end = events.at(-1)! as { flick: boolean };
    expect(end.flick).toBe(false); // movimento lento
  });

  it('soltar muito rápido = flick (toss)', () => {
    const fsm = new GestureFSM();
    const events = collect(fsm);
    fsm.press(pt(0, 0), 'object', 0);
    fsm.move(pt(100, 0), 10); // 100px em 10ms = 10000 px/s ≫ 2500
    fsm.release(pt(300, 0), 20);
    const end = events.at(-1)! as { type: string; flick: boolean };
    expect(end.type).toBe('dragEnd');
    expect(end.flick).toBe(true);
  });

  it('arrastar o CHÃO vira shove (dragStart com target floor)', () => {
    const fsm = new GestureFSM();
    const events = collect(fsm);
    fsm.press(pt(0, 0), 'floor', 0);
    fsm.move(pt(60, 0), 30); // transição → dragStart
    fsm.move(pt(120, 0), 60); // shoveMove
    fsm.release(pt(120, 0), 90);
    expect(events.map((e) => e.type)).toEqual(['dragStart', 'shoveMove', 'shoveEnd']);
    const start = events[0] as { target?: string };
    expect(start.target).toBe('floor');
  });

  it('long-press sem movimento dispara após 500ms', () => {
    const fsm = new GestureFSM();
    const events = collect(fsm);
    fsm.press(pt(10, 10), 'object', 0);
    vi.advanceTimersByTime(499);
    expect(events).toHaveLength(0);
    vi.advanceTimersByTime(2);
    expect(events.map((e) => e.type)).toEqual(['longPress']);
    expect(fsm.getState()).toBe('idle');
  });

  it('movimento além do slop CANCELA o long-press', () => {
    const fsm = new GestureFSM();
    const events = collect(fsm);
    fsm.press(pt(10, 10), 'object', 0);
    fsm.move(pt(60, 10), 30); // vira drag antes do timer
    vi.advanceTimersByTime(1000);
    expect(events.map((e) => e.type)).toEqual(['dragStart']);
  });

  it('cancel volta ao idle emitindo cancel', () => {
    const fsm = new GestureFSM();
    const events = collect(fsm);
    fsm.press(pt(0, 0), 'object', 0);
    fsm.move(pt(60, 0), 30);
    fsm.cancel();
    expect(events.map((e) => e.type)).toEqual(['dragStart', 'cancel']);
    expect(fsm.getState()).toBe('idle');
  });

  it('tap após janela de double-tap conta como tap novo', () => {
    const fsm = new GestureFSM();
    const events = collect(fsm);
    fsm.press(pt(0, 0), 'floor', 0);
    fsm.release(pt(0, 0), 100);
    fsm.press(pt(0, 0), 'floor', 1000); // > 300ms depois
    fsm.release(pt(0, 0), 1050);
    expect(events.map((e) => e.type)).toEqual(['tap', 'tap']);
  });
});
