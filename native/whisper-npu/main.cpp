// Whisper Base inference for Qualcomm AI Hub's v0.65.0 precompiled ONNX pair.
// Host preprocessing/decoding runs on ARM64; both model graphs require QNN HTP.
#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include "json.hpp"
#include "whisper.h"
#include <algorithm>
#include <array>
#include <atomic>
#include <cmath>
#include <complex>
#include <cstring>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <map>
#include <memory>
#include <mutex>
#include <numeric>
#include <onnxruntime_cxx_api.h>
#include <thread>
#include <unordered_map>
#include <vector>
#include <windows.h>

using json = nlohmann::json;
namespace fs = std::filesystem;
static std::atomic<bool> cancelled{false};
static std::mutex outputMutex;
static void checkCancel() {
  if (cancelled)
    throw std::runtime_error("Transcription cancelled");
}
// Keep every sample, choosing a quiet boundary before the model's 10 s limit.
// Fixed cuts can remove partial words from both independently decoded windows.
static std::vector<std::pair<size_t, size_t>>
chunkRanges(const std::vector<int16_t> &samples,
            const std::vector<std::pair<size_t, size_t>> &speech) {
  std::vector<std::pair<size_t, size_t>> chunks;
  constexpr size_t limit = 10 * 16000, window = 1600, step = 160;
  for (auto [begin, finish] : speech) {
    while (begin < finish) {
      checkCancel();
      size_t end = std::min(begin + limit, finish);
      if (end < finish) {
        const size_t searchLimit = end;
        double best = INFINITY;
        // Prefer later equal-energy gaps to avoid unnecessarily short chunks.
        for (size_t candidate = begin + limit / 2;
             candidate + window / 2 <= searchLimit; candidate += step) {
          double energy = 0;
          for (size_t i = candidate - window / 2; i < candidate + window / 2;
               i++) {
            double x = samples[i] / 32768.0;
            energy += x * x;
          }
          if (energy <= best) {
            best = energy;
            end = candidate;
          }
        }
      }
      chunks.emplace_back(begin, end);
      begin = end;
    }
  }
  return chunks;
}
static void emit(const json &value) {
  std::lock_guard<std::mutex> lock(outputMutex);
  std::cout << value.dump(-1, ' ', false, json::error_handler_t::replace)
            << std::endl;
}
static json readJson(const fs::path &file) {
  std::ifstream stream(file);
  if (!stream)
    throw std::runtime_error("Missing " + file.string());
  return json::parse(stream);
}

struct Tensor {
  std::vector<int64_t> shape;
  ONNXTensorElementDataType type;
  std::vector<uint8_t> bytes;
  size_t count() const {
    return std::accumulate(shape.begin(), shape.end(), size_t(1),
                           std::multiplies<size_t>());
  }
  static size_t width(ONNXTensorElementDataType type) {
    if (type == ONNX_TENSOR_ELEMENT_DATA_TYPE_FLOAT16)
      return 2;
    if (type == ONNX_TENSOR_ELEMENT_DATA_TYPE_FLOAT ||
        type == ONNX_TENSOR_ELEMENT_DATA_TYPE_INT32)
      return 4;
    if (type == ONNX_TENSOR_ELEMENT_DATA_TYPE_INT64)
      return 8;
    throw std::runtime_error("Unsupported model tensor type");
  }
  Tensor() : type(ONNX_TENSOR_ELEMENT_DATA_TYPE_UNDEFINED) {}
  Tensor(std::vector<int64_t> shape_, ONNXTensorElementDataType type_)
      : shape(std::move(shape_)), type(type_) {
    bytes.resize(count() * width(type), 0);
  }
  void set(size_t i, float value) {
    if (type == ONNX_TENSOR_ELEMENT_DATA_TYPE_FLOAT16) {
      Ort::Float16_t half(value);
      std::memcpy(bytes.data() + i * 2, &half, 2);
    } else if (type == ONNX_TENSOR_ELEMENT_DATA_TYPE_FLOAT)
      std::memcpy(bytes.data() + i * 4, &value, 4);
    else if (type == ONNX_TENSOR_ELEMENT_DATA_TYPE_INT32) {
      int32_t v = static_cast<int32_t>(value);
      std::memcpy(bytes.data() + i * 4, &v, 4);
    } else {
      int64_t v = static_cast<int64_t>(value);
      std::memcpy(bytes.data() + i * 8, &v, 8);
    }
  }
  float get(size_t i) const {
    if (type == ONNX_TENSOR_ELEMENT_DATA_TYPE_FLOAT16) {
      Ort::Float16_t half;
      std::memcpy(&half, bytes.data() + i * 2, 2);
      return half.ToFloat();
    }
    float value;
    std::memcpy(&value, bytes.data() + i * 4, 4);
    return value;
  }
};
using Tensors = std::map<std::string, Tensor>;

class Graph {
  Ort::Session session{nullptr};
  std::vector<std::string> inputNames, outputNames;

public:
  Tensors blankInputs;
  Graph(Ort::Env &env, const fs::path &file, const fs::path &runtime,
        const fs::path &profile) {
    Ort::SessionOptions options;
    options.SetIntraOpNumThreads(2);
    options.AddConfigEntry("session.disable_cpu_ep_fallback", "1");
    options.EnableProfiling(profile.c_str());
    std::vector<Ort::ConstEpDevice> devices;
    for (auto device : env.GetEpDevices())
      if (std::string(device.EpName()).find("QNN") != std::string::npos)
        devices.push_back(device);
    if (devices.empty())
      throw std::runtime_error("No Qualcomm QNN NPU execution device found. "
                               "Update the Qualcomm NPU driver.");
    options.AppendExecutionProvider_V2(
        env, devices,
        std::unordered_map<std::string, std::string>{
            {"backend_path", (runtime / "QnnHtp.dll").string()},
            {"htp_performance_mode", "balanced"}});
    session = Ort::Session(env, file.c_str(), options);
    Ort::AllocatorWithDefaultOptions allocator;
    for (size_t i = 0; i < session.GetInputCount(); i++) {
      inputNames.emplace_back(
          session.GetInputNameAllocated(i, allocator).get());
      auto typeInfo = session.GetInputTypeInfo(i);
      auto info = typeInfo.GetTensorTypeAndShapeInfo();
      auto shape = info.GetShape();
      if (std::any_of(shape.begin(), shape.end(),
                      [](int64_t x) { return x <= 0; }))
        throw std::runtime_error("NPU model must have static input shapes");
      size_t elements = 1;
      for (auto dim : shape) {
        if (dim > 10000000 || elements > 100000000 / size_t(dim))
          throw std::runtime_error("Unexpected model input tensor size");
        elements *= size_t(dim);
      }
      blankInputs.emplace(inputNames.back(),
                          Tensor(shape, info.GetElementType()));
    }
    for (size_t i = 0; i < session.GetOutputCount(); i++)
      outputNames.emplace_back(
          session.GetOutputNameAllocated(i, allocator).get());
  }
  Tensors run(Tensors &inputs) {
    checkCancel();
    std::vector<const char *> in, out;
    std::vector<Ort::Value> values;
    auto memory =
        Ort::MemoryInfo::CreateCpu(OrtArenaAllocator, OrtMemTypeDefault);
    for (const auto &name : inputNames) {
      auto &t = inputs.at(name);
      in.push_back(name.c_str());
      values.push_back(Ort::Value::CreateTensor(memory, t.bytes.data(),
                                                t.bytes.size(), t.shape.data(),
                                                t.shape.size(), t.type));
    }
    for (const auto &name : outputNames)
      out.push_back(name.c_str());
    auto results =
        session.Run(Ort::RunOptions{nullptr}, in.data(), values.data(),
                    values.size(), out.data(), out.size());
    Tensors tensors;
    for (size_t i = 0; i < results.size(); i++) {
      auto info = results[i].GetTensorTypeAndShapeInfo();
      Tensor t(info.GetShape(), info.GetElementType());
      std::memcpy(t.bytes.data(), results[i].GetTensorRawData(),
                  t.bytes.size());
      tensors.emplace(outputNames[i], std::move(t));
    }
    return tensors;
  }
  std::string endProfile() {
    Ort::AllocatorWithDefaultOptions a;
    return session.EndProfilingAllocated(a).get();
  }
};

// Slaney-normalized 80-bin log-mel features: 16 kHz, FFT 400, hop 160,
// periodic Hann, centered reflect padding, 30-second zero padding.
using Complex = std::complex<float>;
static void fft400(const Complex *input, Complex *output, int stride, int n,
                   const std::map<int, std::vector<Complex>> &roots) {
  if (n == 1) {
    *output = *input;
    return;
  }
  const int radix = n % 2 == 0 ? 2 : 5, size = n / radix;
  for (int j = 0; j < radix; j++)
    fft400(input + j * stride, output + j * size, stride * radix, size, roots);
  std::array<Complex, 400> combined;
  const auto &twiddle = roots.at(n);
  for (int k = 0; k < n; k++) {
    Complex sum = 0;
    for (int j = 0; j < radix; j++)
      sum += output[j * size + k % size] * twiddle[j * k % n];
    combined[k] = sum;
  }
  std::copy_n(combined.data(), n, output);
}

static std::vector<float> logMel(const std::vector<float> &audio) {
  constexpr int bins = 201, frames = 3000, fft = 400;
  constexpr double pi = 3.14159265358979323846;
  std::vector<float> hann(fft), filters(80 * bins), power(frames * bins, 0);
  for (int n = 0; n < fft; n++)
    hann[n] = float(0.5 - 0.5 * std::cos(2 * pi * n / fft));
  std::map<int, std::vector<Complex>> roots;
  for (int n = fft; n > 1; n /= n % 2 == 0 ? 2 : 5) {
    auto &table = roots[n];
    table.resize(n);
    for (int k = 0; k < n; k++)
      table[k] = Complex(float(std::cos(-2 * pi * k / n)),
                         float(std::sin(-2 * pi * k / n)));
  }
  auto hzToMel = [](double hz) {
    return hz < 1000 ? hz / (200.0 / 3)
                     : 15 + std::log(hz / 1000) / (std::log(6.4) / 27);
  };
  auto melToHz = [](double mel) {
    return mel < 15 ? mel * (200.0 / 3)
                    : 1000 * std::exp((mel - 15) * (std::log(6.4) / 27));
  };
  std::vector<double> edges(82);
  for (int i = 0; i < 82; i++)
    edges[i] = melToHz(hzToMel(8000) * i / 81);
  for (int m = 0; m < 80; m++)
    for (int k = 0; k < bins; k++) {
      double hz = k * 40.0;
      filters[m * bins + k] = float(
          std::max(0.0, std::min((hz - edges[m]) / (edges[m + 1] - edges[m]),
                                 (edges[m + 2] - hz) /
                                     (edges[m + 2] - edges[m + 1]))) *
          2 / (edges[m + 2] - edges[m]));
    }
  int useful = std::min(frames, int((audio.size() + 399) / 160));
  std::vector<std::thread> workers;
  for (int worker = 0; worker < 4; worker++)
    workers.emplace_back([&, worker] {
      Complex window[fft], transformed[fft];
      for (int f = worker; f < useful; f += 4) {
        if (cancelled)
          return;
        for (int n = 0; n < fft; n++) {
          int index = f * 160 + n - 200;
          if (index < 0)
            index = -index;
          window[n] = Complex(
              (index < int(audio.size()) ? audio[index] : 0) * hann[n], 0);
        }
        fft400(window, transformed, 1, fft, roots);
        for (int k = 0; k < bins; k++)
          power[f * bins + k] = std::norm(transformed[k]);
      }
    });
  for (auto &w : workers)
    w.join();
  checkCancel();
  std::vector<float> mel(80 * frames);
  float maximum = -10;
  for (int m = 0; m < 80; m++)
    for (int f = 0; f < frames; f++) {
      float sum = 0;
      for (int k = 0; k < bins; k++)
        sum += filters[m * bins + k] * power[f * bins + k];
      float value = std::log10(std::max(sum, 1e-10f));
      mel[m * frames + f] = value;
      maximum = std::max(maximum, value);
    }
  for (auto &value : mel)
    value = (std::max(value, maximum - 8) + 4) / 4;
  return mel;
}

static std::vector<uint32_t> codepoints(const std::string &text) {
  std::vector<uint32_t> result;
  for (size_t i = 0; i < text.size();) {
    uint8_t c = text[i++];
    uint32_t value = c;
    int extra = 0;
    if (c >= 0xf0) {
      value = c & 7;
      extra = 3;
    } else if (c >= 0xe0) {
      value = c & 15;
      extra = 2;
    } else if (c >= 0xc0) {
      value = c & 31;
      extra = 1;
    }
    while (extra-- && i < text.size())
      value = (value << 6) | (uint8_t(text[i++]) & 63);
    result.push_back(value);
  }
  return result;
}

class WhisperNpu {
  Ort::Env env{ORT_LOGGING_LEVEL_WARNING, "openwhispr-npu"};
  std::unique_ptr<Graph> encoder, decoder;
  std::map<int, std::string> tokens;
  std::map<std::string, int> special;
  std::vector<int> languageTokens;
  fs::path profileDir;
  std::unique_ptr<whisper_vad_context, decltype(&whisper_vad_free)> vad{
      nullptr, whisper_vad_free};
  std::string vadPath;

public:
  WhisperNpu(const fs::path &model, const fs::path &runtime,
             const fs::path &profile)
      : profileDir(profile) {
    env.DisableTelemetryEvents();
    fs::create_directories(profile);
    env.RegisterExecutionProviderLibrary(
        "QNNExecutionProvider",
        (runtime / "onnxruntime_providers_qnn.dll").native());
    encoder = std::make_unique<Graph>(env, model / "encoder.onnx", runtime,
                                      profile / "encoder");
    decoder = std::make_unique<Graph>(env, model / "decoder.onnx", runtime,
                                      profile / "decoder");
    auto tokenizer = readJson(model / "tokenizer.json");
    std::map<uint32_t, char> byteMap;
    int next = 256;
    for (int b = 0; b < 256; b++) {
      bool normal =
          (b >= 33 && b <= 126) || (b >= 161 && b <= 172) || (b >= 174);
      byteMap[normal ? b : next++] = char(b);
    }
    for (auto it = tokenizer["model"]["vocab"].begin();
         it != tokenizer["model"]["vocab"].end(); ++it) {
      std::string decoded;
      for (auto c : codepoints(it.key())) {
        auto found = byteMap.find(c);
        if (found != byteMap.end())
          decoded += found->second;
      }
      tokens[it.value().get<int>()] = decoded;
    }
    for (auto &token : tokenizer["added_tokens"])
      special[token["content"].get<std::string>()] = token["id"].get<int>();
    for (const auto &[name, id] : special)
      if ((name.size() == 6 || name.size() == 7) && name.starts_with("<|") &&
          name.ends_with("|>"))
        languageTokens.push_back(id);
    // Probe must execute both graphs with CPU graph fallback forbidden.
    auto input = encoder->blankInputs;
    auto cross = encoder->run(input);
    auto state = decoder->blankInputs;
    for (auto &[name, tensor] : cross)
      state[name] = std::move(tensor);
    state.at("input_ids").set(0, special.at("<|startoftranscript|>"));
    auto &mask = state.at("attention_mask");
    for (size_t i = 0; i < mask.count(); i++)
      mask.set(i, i + 1 == mask.count() ? 0 : -100);
    decoder->run(state);
  }
  json transcribe(const fs::path &pcm, const std::string &language,
                  bool translate, const json &request) {
    std::ifstream file(pcm, std::ios::binary | std::ios::ate);
    if (!file)
      throw std::runtime_error("Cannot read PCM audio");
    auto size = file.tellg();
    if (size <= 0 || size % 2)
      throw std::runtime_error(
          "Expected nonempty 16 kHz mono signed PCM16 audio");
    std::vector<int16_t> samples(size_t(size) / 2);
    file.seekg(0);
    file.read(reinterpret_cast<char *>(samples.data()), size);
    std::string transcript;
    json segments = json::array();
    std::vector<std::pair<size_t, size_t>> speech{{0, samples.size()}};
    const auto requestedVad = request.value("vadModelPath", std::string());
    if (!requestedVad.empty()) {
      if (!vad || requestedVad != vadPath) {
        auto params = whisper_vad_default_context_params();
        params.use_gpu = false;
        params.n_threads = 4;
        vad.reset(whisper_vad_init_from_file_with_params(requestedVad.c_str(),
                                                         params));
        if (!vad)
          throw std::runtime_error("Cannot load the Silero VAD model");
        vadPath = requestedVad;
      }
      const auto config = request.value("vadConfig", json::object());
      auto params = whisper_vad_default_params();
      params.threshold = config.value("threshold", 0.5f);
      params.min_speech_duration_ms = config.value("minSpeechDurationMs", 250);
      params.min_silence_duration_ms =
          config.value("minSilenceDurationMs", 200);
      params.max_speech_duration_s = config.value("maxSpeechDurationS", 30.0f);
      params.speech_pad_ms = config.value("speechPadMs", 100);
      std::vector<float> normalized(samples.size());
      std::transform(samples.begin(), samples.end(), normalized.begin(),
                     [](int16_t x) { return x / 32768.0f; });
      std::unique_ptr<whisper_vad_segments,
                      decltype(&whisper_vad_free_segments)>
          detected(whisper_vad_segments_from_samples(vad.get(), params,
                                                     normalized.data(),
                                                     int(normalized.size())),
                   whisper_vad_free_segments);
      if (!detected)
        throw std::runtime_error("Silero VAD speech detection failed");
      speech.clear();
      for (int i = 0; i < whisper_vad_segments_n_segments(detected.get());
           i++) {
        const size_t start =
            std::min(samples.size(),
                     size_t(std::max(0.0f, whisper_vad_segments_get_segment_t0(
                                               detected.get(), i)) *
                            160));
        const size_t end =
            std::min(samples.size(),
                     size_t(std::max(0.0f, whisper_vad_segments_get_segment_t1(
                                               detected.get(), i)) *
                            160));
        if (end <= start)
          continue;
        if (!speech.empty() && start <= speech.back().second)
          speech.back().second = std::max(end, speech.back().second);
        else
          speech.emplace_back(start, end);
      }
    }
    for (auto [start, end] : chunkRanges(samples, speech)) {
      checkCancel();
      std::vector<float> audio(end - start);
      for (size_t i = start; i < end; i++)
        audio[i - start] = samples[i] / 32768.0f;
      double energy = 0;
      for (float x : audio)
        energy += x * x;
      if (energy / audio.size() < 1e-8)
        continue;
      auto mel = logMel(audio);
      auto inputs = encoder->blankInputs;
      auto &features = inputs.at("input_features");
      for (size_t i = 0; i < mel.size(); i++)
        features.set(i, mel[i]);
      auto cross = encoder->run(inputs);
      auto state = decoder->blankInputs;
      for (auto &[name, tensor] : cross)
        state[name] = std::move(tensor);
      int token = special.at("<|startoftranscript|>"), languageToken = -1;
      if (!language.empty() && language != "auto") {
        auto lang = special.find("<|" + language + "|>");
        if (lang == special.end())
          throw std::runtime_error("Unsupported Whisper language: " + language);
        languageToken = lang->second;
      }
      std::string text;
      for (int position = 0; position < 199; position++) {
        checkCancel();
        state.at("input_ids").set(0, token);
        state.at("position_ids").set(0, position);
        auto &mask = state.at("attention_mask");
        for (size_t i = 0; i < mask.count(); i++)
          mask.set(i, i >= mask.count() - position - 1 ? 0 : -100);
        auto output = decoder->run(state);
        Tensor *logits = nullptr;
        for (auto &[name, tensor] : output) {
          auto key = name;
          if (name.find("cache_self") != std::string::npos) {
            if (key.ends_with("_out"))
              key = key.substr(0, key.size() - 4) + "_in";
            state[key] = std::move(tensor);
          } else if (tensor.count() >= 51865)
            logits = &tensor;
        }
        if (!logits)
          throw std::runtime_error("Decoder output has no logits");
        if (position == 0 && languageToken >= 0)
          token = languageToken;
        else if (position == 1)
          token = special.at(translate ? "<|translate|>" : "<|transcribe|>");
        else if (position == 2)
          token = special.at("<|notimestamps|>");
        else if (position == 0) {
          float best = -INFINITY;
          for (int id : languageTokens) {
            float value = logits->get(id);
            if (value > best) {
              best = value;
              token = id;
            }
          }
        } else {
          float best = -INFINITY;
          token = 0;
          for (size_t i = 0; i < logits->count(); i++) {
            if (i >= 50257 && i != size_t(special.at("<|endoftext|>")))
              continue;
            float value = logits->get(i);
            if (value > best) {
              best = value;
              token = int(i);
            }
          }
        }
        if (token == special.at("<|endoftext|>"))
          break;
        if (position == 198)
          throw std::runtime_error("NPU decoder reached its token limit; use "
                                   "Automatic or CPU for this recording.");
        if (position >= 3 && tokens.count(token))
          text += tokens.at(token);
      }
      if (!text.empty()) {
        transcript += text;
        segments.push_back({{"start", start / 16000.0},
                            {"end", end / 16000.0},
                            {"text", text}});
      }
    }
    return {{"success", true},
            {"text", transcript},
            {"segments", segments},
            {"backend", "qnn-htp"}};
  }
  json finishProfiles() {
    return {encoder->endProfile(), decoder->endProfile()};
  }
};

int main(int argc, char **argv) {
  if (argc == 2 && std::string(argv[1]) == "--self-test") {
    std::array<Complex, 400> input, output;
    constexpr double pi = 3.14159265358979323846;
    for (int n = 0; n < 400; n++)
      input[n] =
          Complex(float(std::sin(n * 0.13) + 0.2 * std::cos(n * 0.31)), 0);
    std::map<int, std::vector<Complex>> roots;
    for (int n = 400; n > 1; n /= n % 2 == 0 ? 2 : 5)
      for (int k = 0; k < n; k++)
        roots[n].emplace_back(float(std::cos(-2 * pi * k / n)),
                              float(std::sin(-2 * pi * k / n)));
    fft400(input.data(), output.data(), 1, 400, roots);
    double error = 0;
    for (int k = 0; k < 400; k++) {
      std::complex<double> reference = 0;
      for (int n = 0; n < 400; n++)
        reference += double(input[n].real()) *
                     std::complex<double>(std::cos(-2 * pi * k * n / 400),
                                          std::sin(-2 * pi * k * n / 400));
      error = std::max(
          error, std::abs(reference - std::complex<double>(output[k].real(),
                                                           output[k].imag())));
    }
    std::vector<int16_t> audio(25 * 16000, 1000);
    std::fill(audio.begin() + 6 * 16000, audio.begin() + 7 * 16000, 0);
    auto chunks = chunkRanges(audio, {{0, audio.size()}});
    bool boundaries = !chunks.empty() && chunks.front().second >= 6 * 16000 &&
                      chunks.front().second <= 7 * 16000 &&
                      chunks.back().second == audio.size();
    for (size_t i = 0; i < chunks.size(); i++)
      boundaries = boundaries && chunks[i].second > chunks[i].first &&
                   chunks[i].second - chunks[i].first <= 10 * 16000 &&
                   (!i || chunks[i].first == chunks[i - 1].second);
    emit({{"fftMaxAbsoluteError", error},
          {"quietBoundaries", boundaries},
          {"success", error < 0.001 && boundaries}});
    return error < 0.001 && boundaries ? 0 : 1;
  }
  SetDefaultDllDirectories(LOAD_LIBRARY_SEARCH_DEFAULT_DIRS);
  std::unique_ptr<WhisperNpu> model;
  std::thread worker;
  std::string line;
  while (std::getline(std::cin, line)) {
    json request;
    try {
      request = json::parse(line);
      std::string op = request.at("op");
      if (op == "cancel") {
        cancelled = true;
        continue;
      }
      if (worker.joinable())
        worker.join();
      cancelled = false;
      if (op == "load" || op == "probe") {
        if (!model)
          model = std::make_unique<WhisperNpu>(
              fs::u8path(request.at("modelDir").get<std::string>()),
              fs::u8path(request.at("runtimeDir").get<std::string>()),
              fs::u8path(request.at("profileDir").get<std::string>()));
        emit({{"id", request["id"]},
              {"result", {{"available", true}, {"backend", "qnn-htp"}}}});
      } else if (op == "transcribe") {
        if (!model)
          throw std::runtime_error("Load an NPU model first");
        worker = std::thread([&, request] {
          try {
            auto result = model->transcribe(
                fs::u8path(request.at("audioPath").get<std::string>()),
                request.value("language", "auto"),
                request.value("translate", false), request);
            emit({{"id", request["id"]}, {"result", result}});
          } catch (const std::exception &error) {
            emit({{"id", request["id"]}, {"error", error.what()}});
          }
        });
      } else if (op == "unload") {
        json profiles = json::array();
        if (model)
          profiles = model->finishProfiles();
        model.reset();
        emit({{"id", request["id"]}, {"result", {{"profiles", profiles}}}});
      } else
        throw std::runtime_error("Unknown helper operation");
    } catch (const std::exception &error) {
      emit({{"id", request.value("id", json(nullptr))},
            {"error", error.what()}});
    }
  }
  cancelled = true;
  if (worker.joinable())
    worker.join();
  return 0;
}
