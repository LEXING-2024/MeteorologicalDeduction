/**
 * V2 · 模拟 Web Worker。
 * 设计锚点：docs/V2/05 §2、01 §10。
 *
 * 主线程只负责 UI/渲染；时间积分、放置校验、回合推进都在这里完成。
 * 消息都带 id，主线程按 id resolve，保证同一关卡内顺序一致。
 */

/// <reference lib="webworker" />

import { Simulation, type ActionReport } from './engine';
import type { CardAction, Frame, LevelDef } from '../core/types';

interface InitMessage {
  type: 'init';
  id: number;
  level: LevelDef;
}
interface PlaceMessage {
  type: 'place';
  id: number;
  action: CardAction;
}
interface AdvanceMessage {
  type: 'advance';
  id: number;
}
type Request = InitMessage | PlaceMessage | AdvanceMessage;

interface StateMessage {
  finished: boolean;
  hour: number;
  round: number;
  actionsUsed: number;
}

const ctx = self as unknown as DedicatedWorkerGlobalScope;
let sim: Simulation | null = null;

function state(): StateMessage {
  if (!sim) throw new Error('simulation not initialized');
  return {
    finished: sim.isFinished,
    hour: sim.currentHour,
    round: sim.currentRound,
    actionsUsed: sim.actionsUsed,
  };
}

ctx.onmessage = (event: MessageEvent<Request>) => {
  const message = event.data;
  try {
    if (message.type === 'init') {
      sim = new Simulation(message.level);
      const frame: Frame = sim.currentFrame();
      ctx.postMessage({ id: message.id, type: 'init', frame, state: state() });
      return;
    }
    if (!sim) throw new Error('simulation not initialized');
    if (message.type === 'place') {
      const report: ActionReport = sim.place(message.action);
      ctx.postMessage({
        id: message.id,
        type: 'place',
        report,
        frame: sim.currentFrame(),
        state: state(),
      });
      return;
    }
    const frames: Frame[] = sim.allFrames as Frame[];
    const from = frames.length;
    sim.advanceRound();
    ctx.postMessage({
      id: message.id,
      type: 'advance',
      frames: (sim.allFrames as Frame[]).slice(from),
      state: state(),
    });
  } catch (error) {
    ctx.postMessage({ id: message.id, type: 'error', message: String(error) });
  }
};
