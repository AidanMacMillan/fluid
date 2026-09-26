{
  "targets": [
    {
      "target_name": "haptics",
      "conditions": [
        ["OS=='mac'", {
          "sources": ["haptics.m"],
          "link_settings": { "libraries": ["-framework AppKit"] },
          "xcode_settings": { "MACOSX_DEPLOYMENT_TARGET": "11.0" }
        }, {
          "type": "none"
        }]
      ]
    }
  ]
}
