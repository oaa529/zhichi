/**
 * @file SettingsPanel.tsx
 * 设置面板：API 配置 + 拟真度控制。
 *
 * 受控组件：数据从 useSessionStore + useChatStore 获取。
 */

import { memo, useState, useCallback } from "react";
import type { FC } from "react";
import { useSessionStore } from "../store/sessionStore";
import { useChatStore } from "../store/chatStore";
import { PROVIDER_PRESETS } from "@wechat-rp/shared-types";
import type { ISimulationConfig, IProviderPreset } from "@wechat-rp/shared-types";
import type { IConnectionTestResult } from "@wechat-rp/core";
import { Icon } from "./Icon";
import { PACING_PRESETS } from "../utils/pacingPresets";

export interface ISettingsPanelProps {
  /** 重建适配器回调（保存配置后调用）。 */
  readonly onRecreateAdapter?: () => void;
  /** 测试连接回调。 */
  readonly onTestConnection?: () => Promise<IConnectionTestResult>;
  /** 导出全部数据为备份文件（返回界面提示文本）。 */
  readonly onExportBackup?: () => IBackupActionResult;
  /** 导入备份文件（与本地数据合并，不删除现有内容）。 */
  readonly onImportBackup?: (file: File) => Promise<IBackupActionResult>;
}

/** 备份操作结果（组装层返回，用于面板内提示）。 */
export interface IBackupActionResult {
  readonly ok: boolean;
  readonly message: string;
}

type TestState =
  | { status: "idle" }
  | { status: "testing" }
  | { status: "success"; result: IConnectionTestResult }
  | { status: "error"; result: IConnectionTestResult };

export const SettingsPanel: FC<ISettingsPanelProps> = memo(
  ({ onRecreateAdapter, onTestConnection, onExportBackup, onImportBackup }) => {
    const apiConfig = useSessionStore((s) => s.apiConfig);
    const apiKey = useSessionStore((s) => s.apiKey);
    const setApiConfig = useSessionStore((s) => s.setApiConfig);
    const setProvider = useSessionStore((s) => s.setProvider);
    const setApiKey = useSessionStore((s) => s.setApiKey);
    const digestConfig = useSessionStore((s) => s.digestConfig);
    const setDigestConfig = useSessionStore((s) => s.setDigestConfig);

    const simulationConfig = useChatStore((s) => s.simulationConfig);
    const userProfile = useSessionStore((s) => s.userProfile);
    const setUserProfile = useSessionStore((s) => s.setUserProfile);
    const updateSimulationConfig = useChatStore((s) => s.updateSimulationConfig);

    const [testState, setTestState] = useState<TestState>({ status: "idle" });
    const [saved, setSaved] = useState(false);
    const [backupState, setBackupState] = useState<IBackupActionResult | null>(
      null,
    );
    const [importing, setImporting] = useState(false);

    const handleExportBackup = useCallback(() => {
      if (!onExportBackup) return;
      setBackupState(onExportBackup());
    }, [onExportBackup]);

    const handleImportFile = useCallback(
      async (event: React.ChangeEvent<HTMLInputElement>) => {
        const file = event.target.files?.[0];
        // 清空 input 的值，否则连续选同一个文件不会再触发 change
        event.target.value = "";
        if (!file || !onImportBackup) return;

        setImporting(true);
        setBackupState({ ok: true, message: `正在导入 ${file.name} …` });
        try {
          setBackupState(await onImportBackup(file));
        } finally {
          setImporting(false);
        }
      },
      [onImportBackup],
    );

    const currentPreset: IProviderPreset | undefined = PROVIDER_PRESETS.find(
      (p) => p.id === apiConfig.provider,
    );
    const isMock = apiConfig.adapter === "mock";

    const handleApiKeyChange = useCallback((key: string) => {
      setApiKey(key);
      setSaved(false);
      setTestState({ status: "idle" });
    }, [setApiKey]);

    const handleConfigChange = useCallback(<K extends keyof typeof apiConfig>(
      key: K,
      value: (typeof apiConfig)[K],
    ) => {
      setApiConfig({ [key]: value } as Partial<typeof apiConfig>);
      setSaved(false);
      setTestState({ status: "idle" });
    }, [setApiConfig]);

    const handleProviderChange = useCallback((provider: typeof apiConfig.provider) => {
      setProvider(provider);
      setSaved(false);
      setTestState({ status: "idle" });
    }, [setProvider]);

    const handleSave = useCallback(() => {
      onRecreateAdapter?.();
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    }, [onRecreateAdapter]);

    const handleTest = useCallback(async () => {
      if (!onTestConnection) return;
      setTestState({ status: "testing" });
      try {
        const result = await onTestConnection();
        setTestState(
          result.ok
            ? { status: "success", result }
            : { status: "error", result },
        );
      } catch (err) {
        setTestState({
          status: "error",
          result: {
            ok: false,
            latencyMs: 0,
            error: err instanceof Error ? err.message : String(err),
            errorKind: "unknown",
          },
        });
      }
    }, [onTestConnection]);

    return (
      <div className="zhichi-settings">
        <section className="zhichi-settings__section">
          <h2 className="zhichi-settings__title">
            <Icon name="sparkles" size={16} />
            API 配置
          </h2>

          <label className="zhichi-settings__field">
            <span className="zhichi-settings__field-label">供应商</span>
            <select
              value={apiConfig.provider}
              onChange={(e) => handleProviderChange(e.target.value as typeof apiConfig.provider)}
              className="zhichi-settings__select"
            >
              {PROVIDER_PRESETS.map((preset) => (
                <option key={preset.id} value={preset.id}>
                  {preset.label}
                </option>
              ))}
            </select>
          </label>

          {currentPreset?.helpUrl && (
            <a
              href={currentPreset.helpUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="zhichi-settings__help-link"
            >
              <Icon name="link" size={12} />
              获取 API Key
            </a>
          )}

          {!isMock && (
            <>
              <label className="zhichi-settings__field">
                <span className="zhichi-settings__field-label">Base URL</span>
                <input
                  type="text"
                  value={apiConfig.baseURL}
                  placeholder="https://api.openai.com/v1"
                  onChange={(e) => handleConfigChange("baseURL", e.target.value)}
                  className="zhichi-settings__input"
                />
              </label>
              <label className="zhichi-settings__field">
                <span className="zhichi-settings__field-label">模型</span>
                <input
                  type="text"
                  value={apiConfig.model}
                  placeholder="gpt-4o-mini"
                  onChange={(e) => handleConfigChange("model", e.target.value)}
                  className="zhichi-settings__input"
                />
              </label>
              <label className="zhichi-settings__field">
                <span className="zhichi-settings__field-label">API Key</span>
                <input
                  type="password"
                  value={apiKey}
                  placeholder={currentPreset?.apiKeyPlaceholder ?? "sk-..."}
                  onChange={(e) => handleApiKeyChange(e.target.value)}
                  className="zhichi-settings__input"
                />
              </label>
              <label className="zhichi-settings__field">
                <span className="zhichi-settings__field-label">
                  温度: {apiConfig.temperature.toFixed(2)}
                </span>
                <input
                  type="range"
                  min="0"
                  max="2"
                  step="0.05"
                  value={apiConfig.temperature}
                  onChange={(e) => handleConfigChange("temperature", Number(e.target.value))}
                  className="zhichi-settings__slider"
                />
              </label>
              <label className="zhichi-settings__field">
                <span className="zhichi-settings__field-label">最大 Token</span>
                <input
                  type="number"
                  min="100"
                  max="32768"
                  value={apiConfig.maxTokens}
                  onChange={(e) => handleConfigChange("maxTokens", Number(e.target.value))}
                  className="zhichi-settings__input"
                />
              </label>
              <label className="zhichi-settings__field">
                <span className="zhichi-settings__field-label">
                  无数据超时（毫秒）
                </span>
                <input
                  type="number"
                  min="3000"
                  step="5000"
                  max="300000"
                  value={apiConfig.timeoutMs}
                  onChange={(e) =>
                    handleConfigChange("timeoutMs", Number(e.target.value))
                  }
                  className="zhichi-settings__input"
                />
              </label>
              <p className="zhichi-settings__hint">
                流式回复只要还在出字就不会被掐断；这一项管的是"多久没有新内容算断"。
                慢一点的供应商（尤其推理模型）可以调到 60 秒以上。
              </p>
              <label className="zhichi-settings__field">
                <span className="zhichi-settings__field-label">最大重试次数</span>
                <input
                  type="number"
                  min="0"
                  max="5"
                  value={apiConfig.maxRetries}
                  onChange={(e) =>
                    handleConfigChange("maxRetries", Number(e.target.value))
                  }
                  className="zhichi-settings__input"
                />
              </label>
            </>
          )}

          {/* 测试结果提示 */}
          {testState.status === "success" && (
            <div className="zhichi-settings__test-result zhichi-settings__test-result--success">
              <Icon name="check" size={14} />
              <span>
                连接成功 · {testState.result.latencyMs}ms
                {testState.result.sample ? ` · "${testState.result.sample}"` : ""}
              </span>
            </div>
          )}
          {testState.status === "error" && (
            <div className="zhichi-settings__test-result zhichi-settings__test-result--error">
              <Icon name="close" size={14} />
              <div className="zhichi-settings__test-result-text">
                <strong>
                  {ERROR_LABELS[testState.result.errorKind ?? "unknown"]}
                </strong>
                <code>{testState.result.error}</code>
              </div>
            </div>
          )}

          {/* 保存成功提示 */}
          {saved && (
            <div className="zhichi-settings__saved-toast">
              <Icon name="check" size={14} />
              <span>已保存</span>
            </div>
          )}

          {/* 双按钮：保存 + 测试连接 */}
          <div className="zhichi-settings__btn-row">
            <button
              type="button"
              className="zhichi-settings__save-btn"
              onClick={handleSave}
            >
              <Icon name="check" size={14} />
              保存
            </button>
            <button
              type="button"
              className="zhichi-settings__test-btn"
              onClick={handleTest}
              disabled={testState.status === "testing" || isMock}
            >
              {testState.status === "testing" ? (
                <>
                  <span className="zhichi-settings__spinner" />
                  测试中...
                </>
              ) : (
                <>
                  <Icon name="search" size={14} />
                  测试连接
                </>
              )}
            </button>
          </div>
          {isMock && (
            <p className="zhichi-settings__hint">
              Mock 模式无需测试连接，保存后会切换到对应适配器。
            </p>
          )}
        </section>

        {/*
          "关于你"：角色卡描述角色、记忆是聊出来的，而这块是用户自己写的稳定背景。
          它每轮都注入 Prompt（不等后台整理），于是角色从第一句就知道在跟谁说话。
        */}
        <section className="zhichi-settings__section">
          <h2 className="zhichi-settings__title">
            <Icon name="contacts" size={16} />
            关于你
          </h2>
          <label className="zhichi-settings__field">
            <span className="zhichi-settings__field-label">希望被怎么称呼</span>
            <input
              type="text"
              value={userProfile.displayName}
              placeholder="留空就是「我」"
              onChange={(e) =>
                setUserProfile({ displayName: e.target.value })
              }
              className="zhichi-settings__input"
            />
          </label>
          <label className="zhichi-settings__field">
            <span className="zhichi-settings__field-label">
              一句话背景（角色每轮都会看到）
            </span>
            <textarea
              value={userProfile.bio}
              rows={2}
              placeholder="例如：25 岁，程序员，独居，养了一只猫"
              onChange={(e) => setUserProfile({ bio: e.target.value })}
              className="zhichi-settings__textarea"
            />
          </label>
          <p className="zhichi-settings__hint">
            这块信息每轮都会随人设一起下发，不像长期记忆那样要等整理提炼——
            角色从第一句起就知道在跟谁说话。
          </p>
        </section>

        <section className="zhichi-settings__section">
          <h2 className="zhichi-settings__title">
            <Icon name="heart" size={16} />
            拟真度控制
          </h2>
          {/* 一键节奏预设：三个参数耦合，逐项调很难调到顺手的组合 */}
          <div className="zhichi-settings__pacing">
            <span className="zhichi-settings__field-label">回复节奏</span>
            <div className="zhichi-settings__pacing-row">
              {PACING_PRESETS.map((preset) => (
                <button
                  key={preset.id}
                  type="button"
                  className="zhichi-settings__pacing-btn"
                  title={preset.hint}
                  onClick={() => updateSimulationConfig(preset.patch)}
                >
                  {preset.label}
                </button>
              ))}
            </div>
          </div>
          <label className="zhichi-settings__field zhichi-settings__field--checkbox">
            <input
              type="checkbox"
              checked={simulationConfig.realismEnabled}
              onChange={(e) =>
                updateSimulationConfig({ realismEnabled: e.target.checked })
              }
            />
            <span>启用拟真引擎</span>
          </label>
          <label className="zhichi-settings__field zhichi-settings__field--checkbox">
            <input
              type="checkbox"
              checked={simulationConfig.scheduleAwarenessEnabled}
              onChange={(e) =>
                updateSimulationConfig({ scheduleAwarenessEnabled: e.target.checked })
              }
            />
            <span>作息感知</span>
          </label>
          <label className="zhichi-settings__field zhichi-settings__field--checkbox">
            <input
              type="checkbox"
              checked={simulationConfig.typoAutoCorrectEnabled}
              onChange={(e) =>
                updateSimulationConfig({ typoAutoCorrectEnabled: e.target.checked })
              }
            />
            <span>错别字自动纠错</span>
          </label>
          <label className="zhichi-settings__field">
            <span className="zhichi-settings__field-label">打字速度</span>
            <select
              value={simulationConfig.typingSpeedCpm}
              onChange={(e) =>
                updateSimulationConfig({
                  typingSpeedCpm: e.target.value as ISimulationConfig["typingSpeedCpm"],
                })
              }
              className="zhichi-settings__select"
            >
              <option value="slow">慢</option>
              <option value="normal">正常</option>
              <option value="fast">快</option>
              <option value="turbo">极快</option>
            </select>
          </label>
          <label className="zhichi-settings__field">
            <span className="zhichi-settings__field-label">
              犹豫概率: {simulationConfig.hesitationProbability.toFixed(2)}
            </span>
            <input
              type="range"
              min="0"
              max="1"
              step="0.05"
              value={simulationConfig.hesitationProbability}
              onChange={(e) =>
                updateSimulationConfig({ hesitationProbability: Number(e.target.value) })
              }
              className="zhichi-settings__slider"
            />
          </label>
          <label className="zhichi-settings__field">
            <span className="zhichi-settings__field-label">
              错别字率: {simulationConfig.typoRate.toFixed(2)}
            </span>
            <input
              type="range"
              min="0"
              max="1"
              step="0.05"
              value={simulationConfig.typoRate}
              onChange={(e) =>
                updateSimulationConfig({ typoRate: Number(e.target.value) })
              }
              className="zhichi-settings__slider"
            />
          </label>
          <label className="zhichi-settings__field">
            <span className="zhichi-settings__field-label">
              撤回概率: {(simulationConfig.recallProbability ?? 0).toFixed(2)}
            </span>
            <input
              type="range"
              min="0"
              max="1"
              step="0.05"
              value={
                // 老存档里没有这个旋钮（类型上是可选字段），按 0 显示
                simulationConfig.recallProbability ?? 0
              }
              onChange={(e) =>
                updateSimulationConfig({
                  recallProbability: Number(e.target.value),
                })
              }
              className="zhichi-settings__slider"
            />
          </label>
          <label className="zhichi-settings__field">
            <span className="zhichi-settings__field-label">
              气泡间隔上限: {simulationConfig.maxInterChunkDelayMs}ms
            </span>
            <input
              type="range"
              min="800"
              max="6000"
              step="200"
              value={simulationConfig.maxInterChunkDelayMs}
              onChange={(e) =>
                updateSimulationConfig({
                  maxInterChunkDelayMs: Number(e.target.value),
                })
              }
              className="zhichi-settings__slider"
            />
          </label>
          <label className="zhichi-settings__field">
            <span className="zhichi-settings__field-label">
              碎片化阈值: {simulationConfig.fragmentationThresholdChars}字
            </span>
            <input
              type="range"
              min="8"
              max="60"
              step="2"
              value={simulationConfig.fragmentationThresholdChars}
              onChange={(e) =>
                updateSimulationConfig({
                  fragmentationThresholdChars: Number(e.target.value),
                })
              }
              className="zhichi-settings__slider"
            />
          </label>
        </section>

        <section className="zhichi-settings__section">
          <h2 className="zhichi-settings__title">
            <Icon name="memory" size={16} />
            记忆与剧情
          </h2>
          <label className="zhichi-settings__field zhichi-settings__field--checkbox">
            <input
              type="checkbox"
              checked={digestConfig.enabled}
              onChange={(e) =>
                setDigestConfig({ enabled: e.target.checked })
              }
            />
            <span>自动整理（AI 自动提炼记忆与剧情）</span>
          </label>
          <label className="zhichi-settings__field">
            <span className="zhichi-settings__field-label">
              整理触发阈值（累计消息条数）
            </span>
            <input
              type="number"
              min={5}
              step={5}
              value={digestConfig.threshold}
              disabled={!digestConfig.enabled}
              onChange={(e) => {
                const value = Number(e.target.value);
                if (!Number.isNaN(value) && value >= 5) {
                  setDigestConfig({ threshold: Math.round(value) });
                }
              }}
              className="zhichi-settings__input"
            />
          </label>
          <label className="zhichi-settings__field">
            <span className="zhichi-settings__field-label">
              每次注入记忆条数上限
            </span>
            <input
              type="number"
              min={1}
              max={30}
              value={digestConfig.maxInject}
              onChange={(e) => {
                const value = Number(e.target.value);
                if (!Number.isNaN(value) && value >= 1 && value <= 30) {
                  setDigestConfig({ maxInject: Math.round(value) });
                }
              }}
              className="zhichi-settings__input"
            />
          </label>
          <label className="zhichi-settings__field">
            <span className="zhichi-settings__field-label">
              单次整理窗口（最多取多少条消息）
            </span>
            <input
              type="number"
              min={10}
              step={10}
              value={digestConfig.maxWindow}
              disabled={!digestConfig.enabled}
              onChange={(e) => {
                const value = Number(e.target.value);
                if (!Number.isNaN(value) && value >= 10) {
                  setDigestConfig({ maxWindow: Math.round(value) });
                }
              }}
              className="zhichi-settings__input"
            />
          </label>
          <label className="zhichi-settings__field">
            <span className="zhichi-settings__field-label">
              事件时间线保留条数
            </span>
            <input
              type="number"
              min={10}
              step={10}
              value={digestConfig.maxEvents}
              onChange={(e) => {
                const value = Number(e.target.value);
                if (!Number.isNaN(value) && value >= 10) {
                  setDigestConfig({ maxEvents: Math.round(value) });
                }
              }}
              className="zhichi-settings__input"
            />
          </label>
          <label className="zhichi-settings__field">
            <span className="zhichi-settings__field-label">
              状态卡快照保留版本数
            </span>
            <input
              type="number"
              min={1}
              max={20}
              value={digestConfig.maxHistory}
              onChange={(e) => {
                const value = Number(e.target.value);
                if (!Number.isNaN(value) && value >= 1 && value <= 20) {
                  setDigestConfig({ maxHistory: Math.round(value) });
                }
              }}
              className="zhichi-settings__input"
            />
          </label>
          <p className="zhichi-settings__hint">
            整理会把「值得记住的事」与剧情事件写入本地记忆库，
            并在后续对话中按相关度注入 prompt。Mock 模式下自动跳过。
          </p>
        </section>

        {/* ---------- 数据备份 ---------- */}
        <section className="zhichi-settings__section">
          <h3 className="zhichi-settings__section-title">数据备份</h3>
          <p className="zhichi-settings__hint">
            角色、聊天记录、记忆与剧情都只存在这台设备的浏览器里，
            清缓存、换浏览器或换电脑都会丢。建议定期导出一份备份。
            备份文件是纯 JSON，不含 API Key。
          </p>
          <div className="zhichi-settings__backup-actions">
            <button
              type="button"
              className="zhichi-settings__backup-btn"
              onClick={handleExportBackup}
              disabled={!onExportBackup}
            >
              <Icon name="download" size={15} />
              导出全部数据
            </button>
            <label
              className={`zhichi-settings__backup-btn${
                importing ? " zhichi-settings__backup-btn--busy" : ""
              }`}
            >
              <Icon name="upload" size={15} />
              {importing ? "导入中…" : "导入备份"}
              <input
                type="file"
                accept="application/json,.json"
                hidden
                onChange={handleImportFile}
                disabled={!onImportBackup || importing}
              />
            </label>
          </div>
          {backupState && (
            <p
              className={`zhichi-settings__backup-result${
                backupState.ok ? "" : " zhichi-settings__backup-result--error"
              }`}
              role="status"
            >
              {backupState.message}
            </p>
          )}
          <p className="zhichi-settings__hint">
            导入是<strong>合并</strong>模式：同 ID 以备份文件为准，
            新内容追加，不会删除你现在的数据；消息按 ID 去重。
          </p>
        </section>
      </div>
    );
  },
);

SettingsPanel.displayName = "SettingsPanel";

const ERROR_LABELS: Record<IConnectionTestResult["errorKind"] & string, string> = {
  network: "网络错误",
  auth: "认证失败（API Key 错误）",
  "not-found": "模型未找到",
  "rate-limit": "请求频率超限",
  server: "服务器错误",
  timeout: "请求超时",
  unknown: "未知错误",
};
