import { useCallback, useEffect, useRef, useState } from 'react';

type SpeechInput = { chapterId: string | null; text: string; hasNextChapter: boolean; onNextChapter(): void };

/** The reader owns this hook so closing a sheet or loading the next chapter cannot stop playback. */
export function useSpeechReader(input: SpeechInput) {
  const supported = typeof window !== 'undefined' && 'speechSynthesis' in window;
  const [rate, setRate] = useState(1);
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);
  const [voiceUri, setVoiceUri] = useState('');
  const [speaking, setSpeaking] = useState(false);
  const [paused, setPaused] = useState(false);
  const [autoNext, setAutoNext] = useState(false);
  const autoNextRef = useRef(false);
  autoNextRef.current = autoNext;
  const [sleepMinutes, setSleepMinutes] = useState(0);
  const [sleepUntil, setSleepUntil] = useState<number | null>(null);
  const [sleepRemaining, setSleepRemaining] = useState(0);
  const [error, setError] = useState('');
  const version = useRef(0);
  const autoStart = useRef(false);
  const current = useRef(input);
  current.current = input;
  const speakRef = useRef<() => void>(() => undefined);
  const previousContent = useRef<{ chapterId: string | null; text: string } | null>(null);

  const stop = useCallback(() => {
    autoStart.current = false;
    version.current++;
    if (supported) window.speechSynthesis.cancel();
    setSpeaking(false); setPaused(false);
  }, [supported]);

  useEffect(() => {
    if (!supported) return;
    const refresh = () => setVoices(window.speechSynthesis.getVoices());
    refresh();
    window.speechSynthesis.addEventListener('voiceschanged', refresh);
    return () => window.speechSynthesis.removeEventListener('voiceschanged', refresh);
  }, [supported]);

  const speak = useCallback(() => {
    const text = current.current.text.replace(/\[\[img:[0-9a-f]{64}\]\]/gi, '').trim();
    if (!supported || !text) return;
    const token = ++version.current;
    window.speechSynthesis.cancel();
    setError(''); setSpeaking(true); setPaused(false);
    // Short utterances avoid native speech engines truncating entire long chapters.
    const chunks = text.split(/\n+/).flatMap((paragraph) => paragraph.match(/[\s\S]{1,180}/g) ?? []);
    const voice = voices.find((item) => item.voiceURI === voiceUri) ?? voices.find((item) => /^zh/i.test(item.lang));
    const play = (index: number) => {
      if (token !== version.current) return;
      if (index >= chunks.length) {
        setSpeaking(false); setPaused(false);
        if (autoNextRef.current && current.current.hasNextChapter) {
          autoStart.current = true;
          current.current.onNextChapter();
        }
        return;
      }
      const utterance = new SpeechSynthesisUtterance(chunks[index]);
      utterance.rate = rate;
      utterance.lang = voice?.lang ?? 'zh-TW';
      if (voice) utterance.voice = voice;
      utterance.onend = () => play(index + 1);
      utterance.onerror = (event) => {
        if (token !== version.current || event.error === 'canceled' || event.error === 'interrupted') return;
        setSpeaking(false); setPaused(false);
        setError('系統語音播放中斷，可按「朗讀」重新開始。背景播放由瀏覽器與裝置控制。');
      };
      window.speechSynthesis.speak(utterance);
    };
    play(0);
  }, [rate, supported, voices, voiceUri]);
  speakRef.current = speak;

  useEffect(() => {
    // Empty text is the conversion/loading interval between chapters; retain the pending continuation.
    if (!input.text || !supported) return;
    const previous = previousContent.current;
    if (previous?.chapterId === input.chapterId && previous.text === input.text) return;
    previousContent.current = { chapterId: input.chapterId, text: input.text };
    version.current++;
    window.speechSynthesis.cancel();
    setSpeaking(false); setPaused(false);
    if (autoStart.current) {
      autoStart.current = false;
      speakRef.current();
    }
  }, [input.chapterId, input.text, supported]);

  useEffect(() => {
    if (!sleepUntil) { setSleepRemaining(0); return; }
    const update = () => {
      const left = Math.max(0, Math.ceil((sleepUntil - Date.now()) / 1000));
      setSleepRemaining(left);
      if (!left) { setSleepMinutes(0); setSleepUntil(null); stop(); }
    };
    update();
    const timer = window.setInterval(update, 1000);
    return () => window.clearInterval(timer);
  }, [sleepUntil, stop]);
  useEffect(() => () => { version.current++; if (supported) window.speechSynthesis.cancel(); }, [supported]);

  return {
    supported, rate, setRate, voices, voiceUri, setVoiceUri, speaking, paused,
    autoNext, setAutoNext, sleepMinutes, sleepRemaining, error, speak, stop,
    togglePause: () => {
      if (paused) window.speechSynthesis.resume(); else window.speechSynthesis.pause();
      setPaused(!paused);
    },
    setSleep: (minutes: number) => {
      setSleepMinutes(minutes); setSleepUntil(minutes ? Date.now() + minutes * 60_000 : null);
    },
  };
}

export function SpeechControls({ controller }: { controller: ReturnType<typeof useSpeechReader> }) {
  const speech = controller;
  if (!speech.supported) return <p className="hint">這個瀏覽器不支援系統語音朗讀。</p>;
  return <section className="speech-controls" aria-label="語音朗讀控制">
    <h3>語音朗讀</h3>
    <div className="row-actions">
      {!speech.speaking ? <button className="btn" onClick={speech.speak}>朗讀本章</button> : <>
        <button className="btn" onClick={speech.togglePause}>{speech.paused ? '繼續' : '暫停'}</button>
        <button className="btn" onClick={speech.stop}>停止</button>
      </>}
    </div>
    <div className="field"><label htmlFor="speech-voice">系統語音</label>
      <select className="input" id="speech-voice" value={speech.voiceUri} disabled={speech.speaking}
        onChange={(event) => speech.setVoiceUri(event.target.value)}>
        <option value="">自動選擇中文語音</option>
        {speech.voices.map((voice) => <option key={voice.voiceURI} value={voice.voiceURI}>{voice.name}（{voice.lang}）</option>)}
      </select>
    </div>
    <div className="field"><label htmlFor="speech-rate">速度</label>
      <select className="input" id="speech-rate" value={speech.rate} disabled={speech.speaking}
        onChange={(event) => speech.setRate(Number(event.target.value))}>
        {[0.75, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2].map((rate) => <option key={rate} value={rate}>{rate}×</option>)}
      </select>
    </div>
    <div className="field"><label htmlFor="speech-sleep">睡眠定時</label>
      <select className="input" id="speech-sleep" value={speech.sleepMinutes} onChange={(event) => speech.setSleep(Number(event.target.value))}>
        <option value={0}>關閉</option><option value={15}>15 分鐘</option><option value={30}>30 分鐘</option><option value={60}>60 分鐘</option>
      </select>
    </div>
    <label className="check-line"><input type="checkbox" checked={speech.autoNext}
      onChange={(event) => speech.setAutoNext(event.target.checked)} />讀完自動下一章</label>
    {speech.sleepRemaining > 0 && <p className="hint">{Math.ceil(speech.sleepRemaining / 60)} 分鐘後停止</p>}
    <p className="hint">關閉設定仍會繼續朗讀。背景播放依瀏覽器及裝置支援；語音與速度在開始朗讀前設定。</p>
    {speech.error && <p className="form-error" role="alert">{speech.error}</p>}
  </section>;
}
