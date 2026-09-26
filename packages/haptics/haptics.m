#import <AppKit/AppKit.h>
#include <node_api.h>

static napi_value Alignment(napi_env env, napi_callback_info info) {
  // Electron's main process runs on the AppKit thread. Ask for the performer
  // each time so macOS applies the current input device and user preferences.
  if ([NSThread isMainThread]) {
    [[NSHapticFeedbackManager defaultPerformer]
        performFeedbackPattern:NSHapticFeedbackPatternAlignment
        performanceTime:NSHapticFeedbackPerformanceTimeNow];
  }
  napi_value result;
  napi_get_undefined(env, &result);
  return result;
}

static napi_value Init(napi_env env, napi_value exports) {
  napi_value alignment;
  napi_create_function(env, "alignment", NAPI_AUTO_LENGTH, Alignment, NULL, &alignment);
  napi_set_named_property(env, exports, "alignment", alignment);
  return exports;
}

NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)
