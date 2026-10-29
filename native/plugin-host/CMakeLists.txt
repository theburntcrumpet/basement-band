# bb-plugin-host: loads VST3 (and LV2 on Linux) instrument plugins for Basement Band
# and renders them on request. It runs as a separate process so a misbehaving plugin can't take
# the app down with it. Built with JUCE (AGPLv3), so this helper is AGPLv3 too — see LICENSE here.

cmake_minimum_required(VERSION 3.22)
project(bb_plugin_host VERSION 0.2.0 LANGUAGES C CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

include(FetchContent)
# Point FETCHCONTENT_SOURCE_DIR_JUCE at a local checkout to skip the download.
FetchContent_Declare(JUCE
  GIT_REPOSITORY https://github.com/juce-framework/JUCE.git
  GIT_TAG 9.0.4
  GIT_SHALLOW TRUE)
FetchContent_MakeAvailable(JUCE)

juce_add_gui_app(bb-plugin-host
  PRODUCT_NAME "bb-plugin-host"
  COMPANY_NAME "Basement Band"
  BUNDLE_ID "org.basementband.pluginhost"
  VERSION ${PROJECT_VERSION}
  MICROPHONE_PERMISSION_ENABLED FALSE)

target_sources(bb-plugin-host PRIVATE Source/Main.cpp)

target_compile_definitions(bb-plugin-host PRIVATE
  JUCE_PLUGINHOST_VST3=1
  JUCE_PLUGINHOST_LV2=$<BOOL:${UNIX}>
  JUCE_JACK=$<BOOL:${UNIX}>
  JUCE_ALSA=$<BOOL:${UNIX}>
  # ASIO on Windows, using the SDK headers JUCE bundles (Steinberg offers the ASIO SDK under GPL-3).
  JUCE_ASIO=$<BOOL:${WIN32}>
  JUCE_WEB_BROWSER=0
  JUCE_USE_CURL=0
  JUCE_APPLICATION_NAME_STRING="$<TARGET_PROPERTY:bb-plugin-host,JUCE_PRODUCT_NAME>"
  JUCE_APPLICATION_VERSION_STRING="$<TARGET_PROPERTY:bb-plugin-host,JUCE_VERSION>")

target_link_libraries(bb-plugin-host PRIVATE
  juce::juce_audio_processors
  juce::juce_audio_devices
  juce::juce_audio_formats
  juce::juce_dsp
  juce::juce_recommended_config_flags
  juce::juce_recommended_warning_flags)
