/**
 * Weather System 完整集成示例
 * 
 * 这个文件展示了如何使用重构后的模块化架构来构建一个完整的游戏
 * 它涵盖了初始化、游戏循环、用户交互等所有关键方面
 */

import Phaser from 'phaser';
import { GameController } from '../src/app/GameController';
import { GameScene } from '../src/scenes/GameScene';
import { PlacementController } from '../src/app/PlacementController';
import { EntityInspector } from '../src/app/EntityInspector';
import { RunOrchestrator } from '../src/app/RunOrchestrator';
import { ProgressStore } from '../src/app/ProgressStore';
import { KeyboardRouter } from '../src/app/KeyboardRouter';
import { MapRenderer } from '../src/rendering/MapRenderer';
import { InteractionController } from '../src/interaction/InteractionController';
import { RunAnimator } from '../src/animation/RunAnimator';
import { Deck } from '../src/ui/deck';
import { LogPanel } from '../src/ui/logPanel';

// ===== Phaser 游戏主类 =====
export class WeatherSystemGame extends Phaser.Game {
  private gameController!: GameController;
  private gameScene!: GameScene;
  
  constructor(config: Phaser.Types.Core.GameConfig) {
    super(config);
    
    // 监听场景创建事件
    this.events.on('ready', this.onGameReady, this);
  }

  private onGameReady(): void {
    console.log('Weather System Game initialized');
  }
}

// ===== 游戏场景类 =====
export class MainGameScene extends GameScene {
  private deck!: Deck;
  private logPanel!: LogPanel;
  private gameController!: GameController;
  private mapRenderer!: MapRenderer;
  private interactionController!: InteractionController;
  private runAnimator!: RunAnimator;
  private progressStore!: ProgressStore;
  private placementController!: PlacementController;
  private entityInspector!: EntityInspector;
  private keyboardRouter!: KeyboardRouter;
  private runOrchestrator!: RunOrchestrator;

  constructor() {
    super({ key: 'MainGame' });
  }

  preload(): void {
    // 预加载游戏资源
    console.log('Preloading game assets...');
    
    // 加载地图纹理
    this.load.image('terrain', 'assets/textures/terrain.png');
    this.load.image('rain', 'assets/textures/rain.png');
    this.load.image('temperature', 'assets/textures/temperature.png');
    
    // 加载 UI 元素
    this.load.image('card-bg', 'assets/ui/card-bg.png');
    this.load.image('entity-highlight', 'assets/ui/entity-highlight.png');
  }

  create(): void {
    console.log('Creating Main Game Scene...');
    
    // 1. 创建 UI 组件
    this.createUIComponents();
    
    // 2. 创建渲染器
    this.createRenderers();
    
    // 3. 创建交互控制器
    this.createInteractionControllers();
    
    // 4. 创建逻辑模块
    this.createLogicModules();
    
    // 5. 创建主控制器（它会协调所有模块）
    this.createMainController();
    
    // 6. 加载第一关
    this.gameController.loadLevel(0);
    
    console.log('Main Game Scene created successfully');
  }

  update(time: number, delta: number): void {
    // 更新动画
    if (this.runAnimator) {
      this.runAnimator.update(delta);
    }
    
    // 更新游戏逻辑
    if (this.gameController) {
      this.gameController.update();
    }
  }

  // ===== UI 组件创建 =====
  private createUIComponents(): void {
    console.log('Creating UI components...');
    
    // 创建牌组
    this.deck = new Deck(this);
    
    // 创建日志面板
    this.logPanel = new LogPanel(this);
    
    // 设置 UI 位置
    this.deck.setPosition(50, 50);
    this.logPanel.setPosition(50, 500);
  }

  // ===== 渲染器创建 =====
  private createRenderers(): void {
    console.log('Creating renderers...');
    
    // 创建地图渲染器
    this.mapRenderer = new MapRenderer(
      {
        scene: this,
        level: null,
        currentLayer: 'low',
        fieldVisibility: {
          isobar: true,
          wind: true,
          rain: true,
          temperature: true,
          source: true,
        },
        legendState: {
          temperature: false,
          wind: false,
          rain: false,
          front: false,
          terrain: false,
        },
        renderQuality: 'full',
      },
      {
        onLegendUpdate: (legendState) => {
          console.log('Legend updated:', legendState);
        },
        onFieldVisibilityChange: (visibility) => {
          console.log('Field visibility changed:', visibility);
        },
      }
    );
    
    // 创建运行动画器
    this.runAnimator = new RunAnimator(
      {
        scene: this,
        animationSpeed: 1.0,
        initialEntities: [],
      },
      {
        onPhaseChange: (phase) => {
          console.log('Animation phase changed:', phase);
          this.runOrchestrator.showRunPhase(phase);
        },
        onComplete: () => {
          console.log('Animation completed');
          this.runOrchestrator.completeRun();
        },
        onEntityUpdate: (entities) => {
          console.log('Entities updated:', entities);
        },
      }
    );
  }

  // ===== 交互控制器创建 =====
  private createInteractionControllers(): void {
    console.log('Creating interaction controllers...');
    
    // 创建主交互控制器
    this.interactionController = new InteractionController(
      {
        scene: this,
        level: null,
        running: false,
        currentLayer: 'low',
        activePlacement: null,
      },
      {
        onEntityClick: this.handleEntityClick.bind(this),
        onEntityDrag: this.handleEntityDrag.bind(this),
        onPlace: this.handlePlace.bind(this),
        onShapeChange: this.handleShapeChange.bind(this),
        onRadiusChange: this.handleRadiusChange.bind(this),
        onCityClick: this.handleCityClick.bind(this),
        onBackgroundClick: this.handleBackgroundClick.bind(this),
        onViewChange: this.handleViewChange.bind(this),
      }
    );
    
    // 创建放置控制器
    this.placementController = new PlacementController(
      {
        scene: this,
        level: null,
        running: false,
        maxEntities: 20,
      },
      {
        onEntityClick: this.handleEntityClick.bind(this),
        onEntityDrag: this.handleEntityDrag.bind(this),
        onPlace: this.handlePlace.bind(this),
        onActiveCardChange: this.handleActiveCardChange.bind(this),
        onFieldModified: this.handleFieldModified.bind(this),
      }
    );
    
    // 创建实体检查器
    this.entityInspector = new EntityInspector(
      {
        level: null,
        running: false,
        entities: [],
        selectedEntityId: null,
      },
      {
        onEntityClick: this.handleEntityClick.bind(this),
        onEntityDrag: this.handleEntityDrag.bind(this),
        onFieldModified: this.handleFieldModified.bind(this),
        onHemisphereChange: this.handleHemisphereChange.bind(this),
        onLayerChange: this.handleLayerChange.bind(this),
        onToast: this.handleToast.bind(this),
      }
    );
  }

  // ===== 逻辑模块创建 =====
  private createLogicModules(): void {
    console.log('Creating logic modules...');
    
    // 创建进度存储器
    this.progressStore = new ProgressStore({
      onProgressUpdate: (completedLevels: number[]) => {
        console.log('Progress updated:', completedLevels);
        this.deck.updateProgress(completedLevels);
      },
      onBoardLoad: (board) => {
        console.log('Board loaded:', board);
        this.gameController.loadLevel(board.levelIndex);
      },
      onCampaignRender: () => {
        console.log('Campaign rendered');
      },
      onToast: this.handleToast.bind(this),
    });
    
    // 创建运行编排器
    this.runOrchestrator = new RunOrchestrator(
      {
        scene: this,
        level: null,
        entities: [],
        round: 0,
      },
      {
        onStart: this.handleRunStart.bind(this),
        onComplete: this.handleRunComplete.bind(this),
        onError: this.handleRunError.bind(this),
      }
    );
    
    // 创建键盘路由器
    this.keyboardRouter = new KeyboardRouter(
      {
        level: null,
        running: false,
        activeCard: null,
        selectedEntityId: null,
        hasActivePanel: false,
        hasCampaignOverlay: false,
        hasStageComplete: false,
        hasManualOverlay: false,
      },
      {
        onCardSelect: this.handleCardSelect.bind(this),
        onEntityRemove: this.handleEntityRemove.bind(this),
        onRunAction: this.handleRunAction.bind(this),
        onUndo: this.handleUndo.bind(this),
        onResetLevel: this.handleResetLevel.bind(this),
        onPlacementMove: this.handlePlacementMove.bind(this),
        onPlacementPlace: this.handlePlacementPlace.bind(this),
        onEntityStrengthChange: this.handleEntityStrengthChange.bind(this),
        onPanelClose: this.handlePanelClose.bind(this),
        onCampaignClose: this.handleCampaignClose.bind(this),
        onManualClose: this.handleManualClose.bind(this),
        onToast: this.handleToast.bind(this),
      }
    );
  }

  // ===== 主控制器创建 =====
  private createMainController(): void {
    console.log('Creating main game controller...');
    
    this.gameController = new GameController({
      scene: this,
      deck: this.deck,
      log: this.logPanel,
    });
  }

  // ===== 事件处理方法 =====
  
  // 实体点击处理
  private handleEntityClick(id: string, button: 'left' | 'right'): void {
    console.log(`Entity clicked: ${id} (${button})`);
    
    if (button === 'right') {
      // 右键删除
      this.entityInspector.removeEntity(id);
    } else {
      // 左键选择
      this.entityInspector.showEntityPopover(
        this.entityInspector.getCurrentEntities().find(e => e.id === id) || null
      );
    }
  }

  // 实体拖拽处理
  private handleEntityDrag(id: string, x: number, y: number, done: boolean): void {
    console.log(`Entity dragged: ${id} to (${x}, ${y}), done: ${done}`);
    
    const entity = this.entityInspector.getCurrentEntities().find(e => e.id === id);
    if (entity) {
      entity.x = x;
      entity.y = y;
      this.gameController.handleFieldModified();
    }
  }

  // 放置处理
  private handlePlace(x: number, y: number, type?: string): void {
    console.log(`Place entity: ${type} at (${x}, ${y})`);
    
    if (type) {
      this.placementController.placeAt(x, y, type);
    }
  }

  // 活动卡牌变化处理
  private handleActiveCardChange(type: string | null): void {
    console.log(`Active card changed: ${type}`);
    this.deck.setActive(type);
  }

  // 字段修改处理
  private handleFieldModified(): void {
    console.log('Field modified');
    this.gameController.refreshField();
  }

  // 运行开始处理
  private handleRunStart(entities: any[]): void {
    console.log('Run started');
    this.logPanel.setRunning();
    this.deck.setRunning(true);
  }

  // 运行完成处理
  private handleRunComplete(result: any): void {
    console.log('Run completed:', result);
    this.logPanel.setCompleted();
    this.deck.setRunning(false);
    
    // 显示结果
    this.showResult(result);
  }

  // 运行错误处理
  private handleRunError(error: Error): void {
    console.error('Run error:', error);
    this.deck.setRunning(false);
    this.handleToast(`运行失败: ${error.message}`, 'error');
  }

  // 卡牌选择处理
  private handleCardSelect(type: string): void {
    this.placementController.selectCard(type as any);
  }

  // 实体删除处理
  private handleEntityRemove(id: string): void {
    this.entityInspector.removeEntity(id);
  }

  // 运行动作处理
  private handleRunAction(skip?: boolean): void {
    if (skip) {
      this.runOrchestrator.skipRun();
    } else {
      this.gameController.handleRun();
    }
  }

  // 撤销处理
  private handleUndo(): void {
    this.runOrchestrator.undo();
  }

  // 重置关卡处理
  private handleResetLevel(): void {
    this.gameController.loadLevel(this.gameController.getCurrentLevelIndex());
  }

  // 形状变化处理
  private handleShapeChange(entityId: string, shape?: Array<{ x: number; y: number }>): void {
    console.log(`Shape changed for entity ${id}:`, shape);
    this.gameController.handleFieldModified();
  }

  // 半径变化处理
  private handleRadiusChange(entityId: string, radius: number): void {
    console.log(`Radius changed for entity ${id}: ${radius}`);
    this.gameController.handleFieldModified();
  }

  // 城市点击处理
  private handleCityClick(cityId: string): void {
    console.log(`City clicked: ${cityId}`);
    this.handleToast(`点击了 ${cityId}`, 'info');
  }

  // 背景点击处理
  private handleBackgroundClick(): void {
    console.log('Background clicked');
    this.entityInspector.clearSelection();
    this.placementController.clearPlacement();
  }

  // 视图变化处理
  private handleViewChange(state: { zoom: number; canReset: boolean; canZoomIn: boolean }): {
    console.log('View changed:', state);
  }

  // 面板关闭处理
  private handlePanelClose(): void {
    console.log('Panel closed');
  }

  // 活动关闭处理
  private handleCampaignClose(): void {
    console.log('Campaign closed');
  }

  // 手册关闭处理
  private handleManualClose(): void {
    console.log('Manual closed');
  }

  // 放置移动处理
  private handlePlacementMove(deltaX: number, deltaY: number): void {
    console.log(`Placement moved: ${deltaX}, ${deltaY}`);
    // 在实际实现中，这里会更新幽灵实体的位置
  }

  // 放置处理
  private handlePlacementPlace(): void {
    console.log('Placement placed');
    // 在实际实现中，这里会在当前位置放置实体
  }

  // 实体强度变化处理
  private handleEntityStrengthChange(direction: number): void {
    console.log(`Entity strength changed: ${direction}`);
    this.entityInspector.nudgeSelectedStrength(direction);
  }

  // Toast 处理
  private handleToast(message: string, type: string = 'info'): void {
    console.log(`Toast: ${message} (${type})`);
    
    // 在实际实现中，这里会显示一个 toast 提示
    if (type === 'error') {
      alert(`错误: ${message}`);
    } else if (type === 'warn') {
      alert(`警告: ${message}`);
    } else {
      alert(`提示: ${message}`);
    }
  }

  // 显示结果
  private showResult(result: any): void {
    console.log('Showing result:', result);
    
    // 在实际实现中，这里会显示一个结果界面
    alert(`推演结果: ${result.success ? '成功' : '失败'}\n${result.message}`);
  }

  // ===== 公共 API =====
  
  public getGameController(): GameController {
    return this.gameController;
  }

  public getMapRenderer(): MapRenderer {
    return this.mapRenderer;
  }

  public getInteractionController(): InteractionController {
    return this.interactionController;
  }

  public getRunAnimator(): RunAnimator {
    return this.runAnimator;
  }
}

// ===== Phaser 游戏配置 =====
const gameConfig: Phaser.Types.Core.GameConfig = {
  type: Phaser.AUTO,
  width: 800,
  height: 600,
  parent: 'game-container',
  backgroundColor: '#87CEEB',
  physics: {
    default: 'arcade',
    arcade: {
      gravity: { y: 0 },
      debug: false,
    },
  },
  scene: [MainGameScene],
};

// ===== 初始化游戏 =====
function initGame(): void {
  // 创建游戏实例
  const game = new WeatherSystemGame(gameConfig);
  
  // 添加错误处理
  game.events.on('error', (error) => {
    console.error('Game error:', error);
    alert(`游戏错误: ${error.message}`);
  });
  
  console.log('Weather System Game initialized successfully');
}

// ===== 主入口 =====
if (typeof window !== 'undefined') {
  window.addEventListener('load', initGame);
}

export { MainGameScene, WeatherSystemGame, initGame };

// ===== 使用说明 =====
/*
使用方法：

1. 将此文件编译到项目中
2. 确保所有依赖模块已正确安装
3. 修改 gameConfig 中的配置以适应您的需求
4. 调用 initGame() 启动游戏

此示例文件展示了：
- 如何初始化所有模块
- 如何配置模块间的通信
- 如何处理各种用户交互
- 如何管理游戏状态
- 如何进行错误处理

您可以根据自己的需求修改和扩展此示例。
*/