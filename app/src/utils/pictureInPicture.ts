// Picture-in-Picture utilities for HTML5 video
import { Logger } from './logging';

/**
 * Check if Picture-in-Picture API is supported
 */
export const isPipSupported = (): boolean => {
  return typeof document !== 'undefined' && document.pictureInPictureEnabled === true;
};

/**
 * Request PiP for a video element
 */
export const requestPip = async (videoElement: HTMLVideoElement): Promise<void> => {
  if (!isPipSupported()) {
    throw new Error('Picture-in-Picture not supported');
  }

  try {
    await videoElement.requestPictureInPicture();
    Logger.info('PiP', 'Picture-in-Picture activated');
  } catch (error) {
    Logger.error('PiP', `Failed to request Picture-in-Picture: ${error}`);
    throw error;
  }
};

/**
 * Exit PiP mode
 */
export const exitPip = async (): Promise<void> => {
  if (document.pictureInPictureElement) {
    try {
      await document.exitPictureInPicture();
      Logger.info('PiP', 'Picture-in-Picture exited');
    } catch (error) {
      Logger.error('PiP', `Failed to exit Picture-in-Picture: ${error}`);
      throw error;
    }
  }
};

/**
 * Check if currently in PiP mode
 */
export const isInPipMode = (): boolean => {
  return typeof document !== 'undefined' && document.pictureInPictureElement !== null;
};
