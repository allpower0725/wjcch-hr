"""以 OS 檔案鎖防止同一份 SQLite 同時執行兩個 collector。"""
import os
from pathlib import Path


class InstanceLock:
    def __init__(self, path: Path):
        self._file = path.open("a+b")
        try:
            if os.name == "nt":
                import msvcrt
                self._file.seek(0)
                self._file.write(b"\0")
                self._file.flush()
                self._file.seek(0)
                msvcrt.locking(self._file.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl
                fcntl.flock(self._file, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            self._file.close()
            raise RuntimeError("同一資料目錄已有 collector 執行，請先停止再切換模式") from None

    def close(self):
        self._file.close()
