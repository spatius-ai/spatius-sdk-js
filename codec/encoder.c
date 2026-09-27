#include <opus.h>

/* Keep variadic libopus controls behind a small, fixed WASM ABI. */
OpusEncoder *encoder_create(int rate, int bitrate, int application) {
  int error;
  OpusEncoder *encoder = opus_encoder_create(rate, 1, application, &error);
  if (!encoder) return 0;
  if (opus_encoder_ctl(encoder, OPUS_SET_BITRATE(bitrate ? bitrate : OPUS_AUTO)) ||
      opus_encoder_ctl(encoder, OPUS_SET_VBR(1)) ||
      opus_encoder_ctl(encoder, OPUS_SET_COMPLEXITY(10)) ||
      opus_encoder_ctl(encoder, OPUS_SET_SIGNAL(OPUS_AUTO)) ||
      opus_encoder_ctl(encoder, OPUS_SET_LSB_DEPTH(16)) ||
      opus_encoder_ctl(encoder, OPUS_SET_DTX(0)) ||
      opus_encoder_ctl(encoder, OPUS_SET_INBAND_FEC(0))) {
    opus_encoder_destroy(encoder);
    return 0;
  }
  return encoder;
}

int encoder_lookahead(OpusEncoder *encoder) {
  int samples;
  int error = opus_encoder_ctl(encoder, OPUS_GET_LOOKAHEAD(&samples));
  return error ? error : samples;
}
