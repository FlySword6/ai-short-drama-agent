import {
  EXTRACT_FACTS_PROMPT_VERSION,
  type ExtractFactsStageContext,
  type ExtractFactsStageExecutor,
  type RecordedStageModelPort,
} from './execution';
import { runPiJsonAgent } from './pi-json';

export const PI_EXTRACT_FACTS_EXECUTOR_VERSION = 'pi-agent-core-extract-facts/1';

const SYSTEM_PROMPT = `你是中文短剧剧本事实拆解 Agent。只输出 JSON 对象，不输出 Markdown。
必须保留原剧情与对白，不得编造原文事实。证据使用输入中的 {chunkId,alias}，至少一个 primary 别名。
结果字段必须是 synopsis,characters,locations,props,scenes,dialogues。
有来源的文字为 {value,evidence:[{chunkId,alias}]}；无法确定用 null，数组无内容用 []。
人物/地点/道具为 {tempId,name,aliases,description,evidence}；场次为 {tempId,order,title,locationTempId,characterTempIds,evidence,timeOfDay}。
对白为 {tempId,sceneTempId,speakerTempId,speakerEvidence,source:{evidence:{chunkId,alias},quote}}。
source.quote 必须是该别名原文中唯一出现的逐字对白内容，不含说话人前缀。tempId 唯一且以字母开头。
场次 evidence 要覆盖该场所有原文段落，所有对白必须拆出。未知说话人用 null 和空 speakerEvidence。`;

/** Pi owns the transcript and lifecycle; the recorded port owns the bounded paid call. */
export class PiExtractFactsStageExecutor implements ExtractFactsStageExecutor {
  readonly version = PI_EXTRACT_FACTS_EXECUTOR_VERSION;

  async execute(context: ExtractFactsStageContext, modelPort: RecordedStageModelPort): Promise<unknown> {
    return runPiJsonAgent({ systemPrompt: SYSTEM_PROMPT,
      prompt: { operation: 'extractFacts', context },
      invoke: (systemPrompt, userText) => modelPort.call({
        operation: 'extractFacts', promptVersion: EXTRACT_FACTS_PROMPT_VERSION,
        systemPrompt, messages: [{ role: 'user', content: userText }],
      }),
    });
  }
}
