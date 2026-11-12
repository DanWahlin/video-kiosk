// Reads a video file in the browser: its length, its picture size, and a JPEG thumbnail.
// The thumbnail is the frame at 15% of the video (1 to 30 seconds), 640 pixels wide, the
// same as the thumbnails that lib/media.js makes with ffmpeg. If the browser cannot play
// the file, the kiosk cannot play it either, so this fails.
export function prepareVideo(blob) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const video = document.createElement('video');
    video.muted = true;
    video.preload = 'auto';
    video.playsInline = true;
    const done = () => {
      clearTimeout(timer);
      video.removeAttribute('src');
      video.load();
      URL.revokeObjectURL(url);
    };
    const fail = (message) => {
      done();
      reject(new Error(message));
    };
    const timer = setTimeout(() => fail('The browser could not read the video in 60 seconds.'), 60_000);
    video.addEventListener('error', () => fail('This browser cannot play the video, so the kiosk cannot play it either. Use an MP4 file with H.264 video and AAC audio.'));
    video.addEventListener('loadedmetadata', () => {
      if (!Number.isFinite(video.duration) || video.duration <= 0) return fail('The video has no length.');
      if (!video.videoWidth) return fail('The file has no picture.');
      video.currentTime = Math.min(Math.max(video.duration * 0.15, 1), 30, video.duration / 2);
    });
    video.addEventListener(
      'seeked',
      () => {
        const width = 640;
        const height = Math.round((width * video.videoHeight) / video.videoWidth / 2) * 2;
        const canvas = Object.assign(document.createElement('canvas'), { width, height });
        canvas.getContext('2d').drawImage(video, 0, 0, width, height);
        const info = { duration: Math.round(video.duration * 100) / 100, width: video.videoWidth, height: video.videoHeight };
        canvas.toBlob(
          (thumbnail) => {
            done();
            thumbnail ? resolve({ ...info, thumbnail }) : reject(new Error('The browser could not make a thumbnail.'));
          },
          'image/jpeg',
          0.82,
        );
      },
      { once: true },
    );
    video.src = url;
  });
}
