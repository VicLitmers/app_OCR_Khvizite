# OCR Services Documentation

This project contains multiple OCR (Optical Character Recognition) services for extracting and parsing text from images, particularly optimized for Korean invoice/receipt processing.

## Prerequisites

- Node.js (v14 or higher recommended)
- npm or yarn package manager
- API keys for the OCR services you plan to use (see [Environment Setup](#environment-setup))

## Installation

1. Clone the repository:
```bash
git clone <repository-url>
cd Khvizite_v1
```

2. Install dependencies:
```bash
npm install
```

## Environment Setup

1. Copy the example environment file:
```bash
cp .env.example .env
```

2. Edit `.env` and add your API keys:
```bash
# Required API Keys
OCR_SPACE_API_KEY=your_ocr_space_api_key_here
GOOGLE_GEMINI_API_KEY=your_google_gemini_api_key_here

# Optional API Keys (for specific services)
RAPIDAPI_KEY=your_rapidapi_key_here
QIANFAN_API_KEY=your_qianfan_api_key_here
MINDDEE_API_KEY=your_mindee_api_key_here
MINDDEE_MODEL_ID=your_mindee_model_id_here

# Google Cloud Vision (requires service account JSON file)
GOOGLE_APPLICATION_CREDENTIALS=/path/to/your/service-account-key.json

# Optional Configuration
IMAGE_PATH=/path/to/default/image.jpg
OCR_CONCURRENCY=1
```

3. **Important**: Never commit your `.env` file to version control. It's already in `.gitignore`.

## Available OCR Services

### 1. OCR AI Service (`ocr_ai.service.js`)
**Main service with AI-powered processing**

- Uses OCR Space API for initial text extraction
- Processes text with Google Gemini AI for structured output
- Optimizes images automatically (resizes to ~1MB for best quality)
- Validates data against schema
- Calculates VAT automatically

**Usage:**
```bash
node ocr_ai.service.js
```

**Features:**
- Automatic image optimization (downscaling/upscaling)
- Text cleaning and normalization
- Header/footer detection
- Schema validation
- AI-powered data refinement
- VAT calculation (10% rounded up)

### 2. OCR Mindee (`ocr_mindee.js`)
**Mindee API for document parsing**

- Specialized for invoice/receipt parsing
- Extracts structured data (items, prices, VAT)
- Automatic image compression

**Usage:**
```bash
# Set IMAGE_PATH in .env file or it will use default path
node ocr_mindee.js
```

**Configuration:**
- Edit `filePath` variable in the file or use environment variables
- Requires Mindee API key and Model ID

