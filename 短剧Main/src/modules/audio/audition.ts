/**
 * S44 裁决 3:试听是预渲染,不是点一次调一次。全站统一试听词写死在这里——
 * 一句有情绪起伏的台词(不用“你好”类平句,听不出音色性格);改词等于作废
 * 全部已渲染产物,只能随显式授权的批量重渲染一起改。
 */
export const VOICE_AUDITION_PHRASE = "你以为我走到今天，靠的只是运气吗？";

/** 试听产物的 TOS 对象路径:每音色一个固定对象,重渲染即覆盖同名对象。 */
export function voiceAuditionStoragePath(voiceType: string): string {
  return `voice-auditions/${voiceType}.mp3`;
}
