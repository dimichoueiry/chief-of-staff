/** Text to speech. macOS `say` today; the interface leaves room for ElevenLabs later. */
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

export interface TtsProvider {
  name: string;
  available(): Promise<boolean>;
  speak(text: string): Promise<void>;
}

export const macSay: TtsProvider = {
  name: "say",
  available: async () => process.platform === "darwin",
  async speak(text) {
    const args: string[] = [];
    if (process.env.COS_VOICE) args.push("-v", process.env.COS_VOICE);
    if (process.env.COS_SPEECH_RATE) args.push("-r", process.env.COS_SPEECH_RATE);
    await exec("say", [...args, text], { maxBuffer: 1024 * 1024 });
  },
};

export async function speak(text: string, provider: TtsProvider = macSay): Promise<void> {
  if (!(await provider.available())) throw new Error(`Text-to-speech provider "${provider.name}" is not available here.`);
  await provider.speak(text);
}
