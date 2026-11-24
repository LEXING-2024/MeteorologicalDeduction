/**
 * V2 · 主线程侧的模拟客户端（Worker 代理）。
 *
 * 对外暴露与 Simulation 同名的只读状态，但 place/advanceRound 都是异步的：
 * 主线程只渲染，重计算在 worker 里。初始帧先在本地算一份，保证切关首屏
 * 立刻有地图；后续帧全部来自 worker。
 */

import type { Grid } from '../core/grid';
import type { CardAction, Frame, LevelDef } from '../core/types';
import type { SceneFields } from '../scene/scene';
import { Simulation, type ActionReport } from './engine';

interface WorkerState {
  finished: boolean;
  hour: number;
  round: number;
  actionsUsed: number;
}

interface WorkerReply {
  id: number;
  type: 'init' | 'place' | 'advance' | 'error';
  frame?: Frame;
  frames?: Frame[];
  report?: ActionReport;
  state?: WorkerState;
  message?: string;
}

interface Pending {
  resolve: (value: WorkerReply) => void;
  reject: (error: Error) => void;
}

export class SimulationClient {
  readonly grid: Grid;
  readonly fields: SceneFields;
  readonly initialFrame: Frame;

  private readonly worker: Worker;
  private readonly pending = new Map<number, Pending>();
  private seq = 0;
  private readyPromise: Promise<void>;
  private readyResolve!: () => void;
  private readyReject!: (error: Error) => void;
  private readySettled = false;

  private frames: Frame[];
  private finished = false;
  private hour = 0;
  private round = 0;
  private actions = 0;

  constructor(level: LevelDef) {
    const bootstrap = new Simulation(level);
    this.grid = bootstrap.grid;
    this.fields = bootstrap.fields;
    this.initialFrame = bootstrap.currentFrame();
    this.frames = [this.initialFrame];
    this.readyPromise = new Promise<void>((resolve, reject) => {
      this.readyResolve = resolve;
      this.readyReject = reject;
    });

    this.worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
    this.worker.onmessage = (event: MessageEvent<WorkerReply>) => this.onMessage(event.data);
    this.worker.onerror = (event) => {
      const error = new Error(event.message || 'simulation worker failed');
      this.rejectReady(error);
      for (const item of this.pending.values()) item.reject(error);
      this.pending.clear();
    };
    this.worker.postMessage({ type: 'init', id: this.nextId(), level });
  }

  get allFrames(): readonly Frame[] {
    return this.frames;
  }

  get isFinished(): boolean {
    return this.finished;
  }

  get currentHour(): number {
    return this.hour;
  }

  get currentRound(): number {
    return this.round;
  }

  get actionsUsed(): number {
    return this.actions;
  }

  currentFrame(): Frame {
    return this.frames[this.frames.length - 1] ?? this.initialFrame;
  }

  async ready(): Promise<void> {
    return this.readyPromise;
  }

  async place(action: CardAction): Promise<ActionReport> {
    await this.readyPromise;
    const reply = await this.request({ type: 'place', action });
    if (reply.frame) {
      if (this.frames.length === 0) this.frames.push(reply.frame);
      else this.frames[this.frames.length - 1] = reply.frame;
    }
    return reply.report ?? { ok: false, reason: 'worker 未返回放置结果' };
  }

  async advanceRound(): Promise<void> {
    await this.readyPromise;
    const reply = await this.request({ type: 'advance' });
    if (reply.frames?.length) this.frames = [...this.frames, ...reply.frames];
  }

  destroy(): void {
    this.worker.terminate();
    const error = new Error('simulation client destroyed');
    this.rejectReady(error);
    for (const item of this.pending.values()) item.reject(error);
    this.pending.clear();
  }

  private nextId(): number {
    this.seq += 1;
    return this.seq;
  }

  private request(payload: { type: 'place'; action: CardAction } | { type: 'advance' }): Promise<WorkerReply> {
    const id = this.nextId();
    return new Promise<WorkerReply>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ ...payload, id });
    });
  }

  private onMessage(reply: WorkerReply): void {
    if (reply.type === 'init') {
      if (reply.frame) this.frames = [reply.frame];
      if (reply.state) this.applyState(reply.state);
      this.readySettled = true;
      this.readyResolve();
      return;
    }
    const item = this.pending.get(reply.id);
    if (reply.type === 'error' && !item) {
      this.rejectReady(new Error(reply.message ?? 'simulation worker error'));
      return;
    }
    if (!item) return;
    this.pending.delete(reply.id);
    if (reply.type === 'error') {
      item.reject(new Error(reply.message ?? 'simulation worker error'));
      return;
    }
    if (reply.state) this.applyState(reply.state);
    item.resolve(reply);
  }

  private rejectReady(error: Error): void {
    if (this.readySettled) return;
    this.readySettled = true;
    this.readyReject(error);
  }

  private applyState(state: WorkerState): void {
    this.finished = state.finished;
    this.hour = state.hour;
    this.round = state.round;
    this.actions = state.actionsUsed;
  }
}
