import type { GoalEvaluation, LevelDefinition } from '../logic/types';
import type { RunReport } from '../logic/report';

/** Escape every HTML metacharacter before interpolating into a template. */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Report copy uses <b> for emphasis; re-enable that one tag after escaping. */
function richText(value: string): string {
  return escapeHtml(value).replace(/&lt;(\/?b)&gt;/g, '<$1>');
}

export class LogPanel {
  private drawer: HTMLElement;
  private toggle: HTMLButtonElement;
  private status: HTMLElement;
  private summary: HTMLElement;
  private toggleCopy: HTMLElement;
  private verdictKicker: HTMLElement;
  private verdictTitle: HTMLElement;
  private verdictText: HTMLElement;
  private recommendation: HTMLElement;
  private stages: HTMLElement;
  private expanded = false;

  constructor() {
    this.drawer = this.require('log-drawer');
    this.toggle = this.require('log-toggle') as HTMLButtonElement;
    this.status = this.require('log-status');
    this.summary = this.require('log-summary');
    this.toggleCopy = this.require('log-toggle-copy') as HTMLElement;
    this.verdictKicker = this.require('log-verdict-kicker');
    this.verdictTitle = this.require('log-verdict-title');
    this.verdictText = this.require('log-verdict-text');
    this.recommendation = this.require('log-recommendation');
    this.stages = this.require('log-stages');

    this.toggle.addEventListener('click', () => this.toggleExpanded());
  }

  setIdle(level: LevelDefinition): void {
    this.status.className = 'log-status idle';
    this.status.innerHTML = '<i></i>等待推演';
    this.summary.textContent = '放置天气系统后运行推演';
    this.verdictKicker.textContent = `第 ${level.index} 关`;
    this.verdictTitle.textContent = '尚未推演';
    this.verdictText.textContent = '按空格或点击运行推演，系统会依次结算风场、垂直运动与降水。';
    this.recommendation.textContent = '';
    this.stages.innerHTML = `
      <article class="log-stage empty">
        <header><span>1</span><strong>风与输送</strong></header>
        <p>等待推演</p>
      </article>
      <article class="log-stage empty">
        <header><span>2</span><strong>垂直运动</strong></header>
        <p>等待推演</p>
      </article>
      <article class="log-stage empty">
        <header><span>3</span><strong>凝结降水</strong></header>
        <p>等待推演</p>
      </article>
    `;
    this.collapse();
  }

  setRunning(): void {
    this.status.className = 'log-status';
    this.status.innerHTML = '<i></i>推演中';
    this.summary.textContent = '正在按风 → 上升/下沉 → 降水顺序结算';
  }

  setDirty(): void {
    if (!this.status.classList.contains('passed') && !this.status.classList.contains('failed')) return;
    this.status.className = 'log-status dirty';
    this.status.innerHTML = '<i></i>场地已修改';
    this.summary.textContent = '上一次结果已过期，重新运行以刷新判定';
  }

  showReport(
    report: RunReport,
    evaluation: GoalEvaluation,
    level: LevelDefinition,
    autoExpand: boolean,
  ): void {
    const passed = evaluation.passed;
    const holding = Boolean(evaluation.holding);
    this.status.className = `log-status ${passed ? 'passed' : holding ? 'holding' : 'failed'}`;
    this.status.innerHTML = `<i></i>${passed ? '推演通过' : holding ? '持续条件达成' : '推演未通过'}`;
    this.summary.textContent = `${evaluation.actual}  ·  ${evaluation.target}`;
    this.verdictKicker.textContent = passed
      ? '目标达成'
      : holding
        ? '条件持续中'
        : '目标未达成';
    this.verdictTitle.textContent = report.verdict;
    this.verdictText.textContent = report.detail;
    this.recommendation.textContent = report.recommendation;
    this.recommendation.style.color = passed ? '#85b9ac' : holding ? '#8fc9d2' : '#b09a7e';

    this.stages.innerHTML = report.stages
      .map(
        (stage) => `
          <article class="log-stage">
            <header>
              <span>${escapeHtml(stage.index)}</span>
              <strong>${escapeHtml(stage.title)}</strong>
            </header>
            <p>${richText(stage.summary)}</p>
            <div class="log-entries">
              ${stage.entries
                .map(
                  (entry) => `
                    <div class="log-entry">
                      <span>${escapeHtml(entry.label)}</span>
                      <p class="${escapeHtml(entry.tone ?? '')}">${richText(entry.text)}</p>
                    </div>
                  `,
                )
                .join('')}
            </div>
          </article>
        `,
      )
      .join('');

    if (autoExpand) this.expand();
    else this.collapse();

    // Keep the level reference meaningful for future per-level log extensions.
    this.drawer.dataset.level = level.id;
  }

  expand(): void {
    this.expanded = true;
    this.drawer.classList.remove('collapsed');
    this.toggle.setAttribute('aria-expanded', 'true');
    this.toggleCopy.textContent = '收起日志';
  }

  collapse(): void {
    this.expanded = false;
    this.drawer.classList.add('collapsed');
    this.toggle.setAttribute('aria-expanded', 'false');
    this.toggleCopy.textContent = '展开日志';
  }

  private toggleExpanded(): void {
    if (this.expanded) this.collapse();
    else this.expand();
  }

  private require(id: string): HTMLElement {
    const element = document.getElementById(id);
    if (!element) throw new Error(`Missing element #${id}`);
    return element;
  }
}
