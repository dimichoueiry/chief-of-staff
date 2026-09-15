/** Text to speech. macOS `say` today; the interface leaves room for another voice later. */
import { spawn, type ChildProcess } from "node:child_process";

export interface TtsProvider {
  name: string;
  available(): Promise<boolean>;
  speak(text: string): Promise<void>;
}

let current: ChildProcess | null = null;

/** Stop whatever is being spoken. Returns true if something was playing. */
export function stopSpeaking(): boolean {
  if (!current) return false;
  current.kill();
  current = null;
  return true;
}

export function isSpeaking(): boolean {
  return current !== null;
}

export const macSay: TtsProvider = {
  name: "say",
  available: async () => process.platform === "darwin",
  speak(text) {
    return new Promise<void>((resolve, reject) => {
      stopSpeaking();
      const args: string[] = [];
      if (process.env.COS_VOICE) args.push("-v", process.env.COS_VOICE);
      if (process.env.COS_SPEECH_RATE) args.push("-r", process.env.COS_SPEECH_RATE);
      const child = spawn("say", [...args, text], { stdio: "ignore" });
      current = child;
      child.on("error", (err) => {
        if (current === child) current = null;
        reject(err);
      });
      child.on("exit", (code, signal) => {
        if (current === child) current = null;
        // Killed by stopSpeaking() is a normal end, not a failure.
        if (code === 0 || signal) resolve();
        else reject(new Error(`say exited with code ${code}`));
      });
    });
  },
};

export async function speak(text: string, provider: TtsProvider = macSay): Promise<void> {
  if (!(await provider.available())) throw new Error(`Text-to-speech provider "${provider.name}" is not available here.`);
  await provider.speak(text);
}
