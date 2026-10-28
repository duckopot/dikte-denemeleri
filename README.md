# Dikte – tarayıcıda Whisper (model seçimli)

**Model seçimi (m4):** açılışta liste: `iPhone için (küçük)` = onnx-community/whisper-small (encoder q4 66 MB + decoder int8 157 MB = 223 MB, WASM) ve `Turbo (büyük, bilgisayar için)` = whisper-large-v3-turbo (aşağıda). iOS'ta küçük, diğerlerinde turbo önerilir; seçim `localStorage['dikte.model']`'de tutulur, `?model=small|turbo` ile zorlanır. Her modelin önbelleği ayrı (anahtarlar model deposunun URL'si), "Seçili modeli sil" / "Hepsini sil" bağlantıları var.


Statik sayfa. Sunucu, analitik, CDN yok (çalışma anında). Ses cihazdan çıkmaz.
- `@huggingface/transformers` 3.8.1 → `vendor/transformers.min.js` + ONNX Runtime wasm (yerel).
  `transformers.min.js` içinde tek bir yama var (dosyanın başındaki "dikte patch" yorumu): oturumlar (encoder, decoder) paralel değil
  **sırayla** okunup kuruluyor ve model baytları oturum kurulur kurulmaz serbest bırakılıyor (en yüksek bellek düşüyor).
- Model: `onnx-community/whisper-large-v3-turbo`, ilk açılışta huggingface.co'dan bir kez.
  - WebGPU + shader-f16: encoder+decoder **q4f16** (370 + 194 MB = 564 MB)
  - WebGPU f16'sız: **q4** (425 + 334 MB = 759 MB)
  - WebGPU yok: WASM **q4** (759 MB)
- İndirme (`worker.js`): dosyalar 8 MB'lık Range parçalarıyla (2 paralel) doğrudan Cache Storage'a yazılır
  (`model-chunks-v1`). Hiçbir an dosyanın tamamı JS belleğinde tutulmaz; kesilirse kaldığı yerden devam eder.
  Range çalışmazsa tek akışlı indirme yapılır ve yine 8 MB'lık parçalara bölünerek yazılır.
  Eski `transformers-cache` içinde tam dosya varsa o kullanılır.
- Çökme tanısı: yükleme aşaması + indirilen bayt + cihaz/dtype `localStorage['dikte.trace']`'e yazılır.
  Sayfa çöküp yeniden açılırsa "Son deneme şu aşamada kesildi: …" gösterilir ve otomatik yükleme yapılmaz.
- `sw.js` (sürüm `dikte-v2`): sayfayı çevrimdışı çalıştırır, COOP/COEP ekler. Küçük dosyalar önce ağdan (güncel kalsın), büyük wasm/mjs önce önbellekten.
  Model önbellekleri `dikte-` ile BAŞLAMAMALI (activate eski `dikte-*` önbelleklerini siler).

## URL parametreleri (deney için)
- `?device=wasm` WebGPU'yu atla · `?device=webgpu` WebGPU'yu zorla (hata olursa WASM'a düşmez)
- `?enc=q4|q4f16|bnb4|int8` `&dec=…` encoder/decoder sayısal türü (ör. `?enc=q4&dec=q4`: f16'sız yol)
- `?thr=1..4` WASM iş parçacığı sayısı · `?opt=disabled|basic|extended|all` ONNX grafik optimizasyonu
- `?xs=disable_prepacking,use_device_allocator_for_initializers` ONNX oturum ayarları (deney)
- `?norange=1` Range'siz indirme yolunu test et · `?dbg=1` ham ilerleme olayları

## GitHub Pages
Bu klasörün içeriğini bir repo'nun köküne yükle, Settings → Pages. HTTPS gerekir (mikrofon için şart).
iPhone: Paylaş → "Ana Ekrana Ekle" (depolamanın silinme riskini azaltır).
Güncelleme sonrası sayfayı iki kez yenile (ilk yenilemede yeni service worker kurulur).
