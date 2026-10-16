"""Project-local audio I/O. Memory only, no files, no persistent mic stream."""
import threading
import numpy as np


class LocalAudio:
    def __init__(self, sd=None):
        if sd is None:
            import sounddevice as sd
        self.sd = sd
        self.stream = None
        self.lock = threading.Lock()
        self.frames = []
        self.samples = 0
        self.overflowed = False
        self.capture_id = 0

    def start_feed(self, receive):
        self.cancel()
        identity = self.capture_id
        def callback(pcm, count, time, status):
            if identity == self.capture_id:
                receive(pcm[:, 0].copy(), bool(status) or count != 800)
        self.stream = self.sd.InputStream(samplerate=16000, channels=1, dtype='float32',
                                          blocksize=800, callback=callback)
        try:
            self.stream.start()
        except Exception:
            self.cancel()
            raise

    def start(self, level):
        self.cancel()
        identity = self.capture_id
        self.overflowed = False
        def callback(pcm, count, time, status):
            with self.lock:
                if identity != self.capture_id:
                    return
                if self.samples + count > 16000 * 30:
                    self.overflowed = True
                    return
                self.frames.append(pcm[:, 0].copy())
                self.samples += count
            level(float(min(1., np.sqrt(np.mean(pcm ** 2)) * 4)))
        self.stream = self.sd.InputStream(samplerate=16000, channels=1, dtype='float32',
                                          blocksize=800, callback=callback)
        try:
            self.stream.start()
        except Exception:
            self.cancel()
            raise

    def close_mic(self):
        self.capture_id += 1
        stream, self.stream = self.stream, None
        if stream is not None:
            try:
                stream.stop()
            finally:
                stream.close()

    def finish(self):
        self.close_mic()
        with self.lock:
            pcm = (np.concatenate(self.frames) if self.frames and not self.overflowed
                   else np.empty(0, dtype=np.float32))
            self.frames.clear()
            self.samples = 0
        return pcm

    def cancel(self):
        self.close_mic()
        with self.lock:
            self.frames.clear()
            self.samples = 0

    def play(self, pcm, rate, cancelled, level):
        self.close_mic()
        if cancelled.is_set() or not len(pcm):
            return
        with self.sd.OutputStream(samplerate=rate, channels=1, dtype='float32',
                                  blocksize=1102, latency='low') as output:
            for start in range(0, len(pcm), 1102):
                if cancelled.is_set():
                    break
                block = pcm[start:start + 1102]
                output.write(block.reshape(-1, 1))
                level(float(min(1., np.sqrt(np.mean(block ** 2)) * 4)))
