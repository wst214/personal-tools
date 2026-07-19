import { getMinioUploadDefaults, uploadRadarFrames } from "./minio-upload.js";
import { getDeviceUploadDefaults, sendDeviceToKafka } from "./device-kafka-upload.js";

export function getUploadTestDefaults() {
  return {
    minio: getMinioUploadDefaults(),
    device: getDeviceUploadDefaults(),
  };
}

export { uploadRadarFrames, sendDeviceToKafka };
