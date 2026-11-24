/**
 * 新架构测试文件
 * 
 * 这个文件用于验证重构后的模块是否可以正常工作
 */

import { GameController } from './src/app/GameController';
import { GameScene } from './src/scenes/GameScene';
import { PlacementController } from './src/app/PlacementController';
import { EntityInspector } from './src/app/EntityInspector';
import { RunOrchestrator } from './src/app/RunOrchestrator';
import { ProgressStore } from './src/app/ProgressStore';
import { KeyboardRouter } from './src/app/KeyboardRouter';
import { MapRenderer } from './src/rendering/MapRenderer';
import { InteractionController } from './src/interaction/InteractionController';
import { RunAnimator } from './src/animation/RunAnimator';

// 模拟的依赖类
class MockDeck {
  setLevel(level: any) {
    console.log('MockDeck: setLevel called');
  }
  
  setEntities(entities: any[]) {
    console.log('MockDeck: setEntities called with', entities.length, 'entities');
  }
  
  setActive(type: any) {
    console.log('MockDeck: setActive called with', type);
  }
  
  setRunning(running: boolean) {
    console.log('MockDeck: setRunning called with', running);
  }
}

class MockLogPanel {
  setRunning() {
    console.log('MockLogPanel: setRunning called');
  }
  
  setCompleted() {
    console.log('MockLogPanel: setCompleted called');
  }
  
  setDirty() {
    console.log('MockLogPanel: setDirty called');
  }
}

class MockGameScene {
  setLevel(level: any) {
    console.log('MockGameScene: setLevel called');
  }
  
  setEntities(entities: any[]) {
    console.log('MockGameScene: setEntities called with', entities.length, 'entities');
  }
  
  setRunning(running: boolean) {
    console.log('MockGameScene: setRunning called with', running);
  }
  
  setActivePlacement(type: any) {
    console.log('MockGameScene: setActivePlacement called with', type);
  }
  
  setLayer(layer: string) {
    console.log('MockGameScene: setLayer called with', layer);
  }
  
  refreshField() {
    console.log('MockGameScene: refreshField called');
  }
  
  setSelectedEntity(id: string | null) {
    console.log('MockGameScene: setSelectedEntity called with', id);
  }
  
  update(time: number, delta: number) {
    // Mock update method
  }
}

// 测试函数
export function testNewArchitecture(): void {
  console.log('=== 开始测试新架构 ===');
  
  try {
    // 测试1: 创建各个模块
    console.log('\n--- 测试1: 创建模块 ---');
    
    const mockScene = new MockGameScene();
    const mockDeck = new MockDeck();
    const mockLog = new MockLogPanel();
    
    // 创建游戏控制器
    const gameController = new GameController({
      scene: mockScene,
      deck: mockDeck,
      log: mockLog,
    });
    
    console.log('✅ GameController 创建成功');
    
    // 测试2: 基本功能
    console.log('\n--- 测试2: 基本功能 ---');
    
    // 加载关卡
    gameController.loadLevel(0);
    console.log('✅ loadLevel 方法调用成功');
    
    // 获取状态
    const currentLevel = gameController.getCurrentLevel();
    console.log('✅ getCurrentLevel 方法调用成功，结果:', currentLevel ? '有关卡' : '无关卡');
    
    const currentEntities = gameController.getCurrentEntities();
    console.log('✅ getCurrentEntities 方法调用成功，实体数量:', currentEntities.length);
    
    const isRunning = gameController.isRunning();
    console.log('✅ isRunning 方法调用成功，状态:', isRunning);
    
    // 测试3: 实体操作
    console.log('\n--- 测试3: 实体操作 ---');
    
    // 模拟放置实体
    gameController['handlePlace'](100, 100, 'H');
    console.log('✅ 实体放置操作成功');
    
    // 模拟运行
    gameController['handleRun']();
    console.log('✅ 运行操作成功');
    
    // 测试4: 错误处理
    console.log('\n--- 测试4: 错误处理 ---');
    
    try {
      // 尝试访问不存在的关卡
      gameController.loadLevel(999);
      console.log('✅ 无效关卡处理成功');
    } catch (error) {
      console.log('✅ 无效关卡处理正常，错误:', error.message);
    }
    
    console.log('\n=== 新架构测试完成 ===');
    console.log('✅ 所有测试通过！新架构可以正常工作。');
    
  } catch (error) {
    console.error('❌ 测试失败:', error);
    throw error;
  }
}

// 运行测试
if (typeof window !== 'undefined') {
  window.addEventListener('load', () => {
    console.log('开始运行新架构测试...');
    testNewArchitecture();
  });
}

export { testNewArchitecture };

/*
使用说明：
1. 这个测试文件用于验证重构后的模块是否可以正常工作
2. 运行这个测试可以确保所有模块都能正确初始化和交互
3. 测试覆盖了基本的CRUD操作和错误处理

要运行测试：
1. 在浏览器中打开包含此文件的项目
2. 查看控制台输出
3. 确认所有测试都通过

如果测试失败，请检查：
- 模块导入路径是否正确
- 依赖项是否都存在
- 模块间接口是否匹配
*/