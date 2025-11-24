require('dotenv').config();
const mindee = require("mindee");
const fs = require("fs");
const path = require("path");
// for TS or modules:
// import * as mindee from "mindee";

// Get configuration from environment variables
const apiKey = process.env.MINDDEE_API_KEY || "md_km7TCX2VEgGv5rMLUDdqbOBGmIlUVARm";
const defaultImagePath = path.join(__dirname, 'images', 'pic6.jpg');
const filePath = process.env.IMAGE_PATH || defaultImagePath;
const modelId = process.env.MINDDEE_MODEL_ID || "04e3bb9d-3c59-4d54-8349-7e131d65696b";


// Init a new client
const mindeeClient = new mindee.ClientV2({ apiKey: apiKey });

// Set inference parameters
const inferenceParams = {
  modelId: modelId,

  // Options: set to `true` or `false` to override defaults

  // Enhance extraction accuracy with Retrieval-Augmented Generation.
  rag: undefined,
  // Extract the full text content from the document as strings.
  rawText: undefined,
  // Calculate bounding box polygons for all fields.
  polygon: undefined,
  // Boost the precision and accuracy of all extractions.
  // Calculate confidence scores for all fields.
  confidence: undefined,
};

// Load a file from disk
const inputSource = new mindee.PathInput({ inputPath: filePath });

// Async function to handle the OCR processing
async function processOCR() {
  try {
    // Validate that the file exists
    if (!fs.existsSync(filePath)) {
      throw new Error(`Image file not found: ${filePath}. Please set IMAGE_PATH in .env file or provide a valid path.`);
    }
    
    // Validate API key is set
    if (!process.env.MINDDEE_API_KEY && apiKey === "md_km7TCX2VEgGv5rMLUDdqbOBGmIlUVARm") {
      console.warn('Warning: Using default Mindee API key. Please set MINDDEE_API_KEY in .env file for production use.');
    }
    // Compress the image before processing
    await inputSource.compress(85, 1920, 1920);
    
    // Send for processing
    const resp = await mindeeClient.enqueueAndGetInference(
      inputSource,
      inferenceParams
    );
    
    // Handle the response
    processResponse(resp);
  } catch (error) {
    console.error('Error processing OCR:', error);
  }
}
function extractMultiplier(specification) {
  // Use regular expression to find number after 'x', 'X', or '*'
  // Pattern matches: x3, X3, *12, x 3, etc.
  // If no separator found, default to 1
  const match = specification ? specification.match(/[xX*]\s*(\d+)/) : null;
  return match ? parseInt(match[1]) : 1;
}
function extractSpecificationWord(specification) {
  // Check if specification is valid
  if (!specification) return "";
  // Split by 'x', 'X', or '*' and take the first part, trimming whitespace
  const parts = specification.split(/[xX*]/);
  return parts[0].trim();
}
function extractSpecificationWordQuantity(specification) {
  // If specification is null or empty, return default values
  if (!specification || specification === 'null' || specification.trim() === '') {
    return { quantity: 1, unit: "items" };
  }
  
  // Get the part before 'x', 'X', or '*' (e.g., "3kg" from "[3kgx3개/박스]")
  const data = extractSpecificationWord(specification);
  
 
  
  if (!data || typeof data !== 'string' || data.trim() === '') {
    return { quantity: 1, unit: "items" };
  }

  // Remove brackets, parentheses, and common prefixes like "- " if present
  const cleaned = data.replace(/[\[\]()]/g, '').replace(/^-\s*/, '').trim();
  
  
  // Handle cases with extra trailing numbers (e.g., "750ml 162" → extract only "750ml")
  // Split by space followed by digits to remove trailing numbers
  const partsWithoutTrailingNumbers = cleaned.split(/\s+\d+/)[0];
  
  
  // Extract leading number and unit (e.g., "3kg" → quantity=3, unit="kg", "100매" → quantity=100, unit="매")
  // Pattern: one or more digits (can have decimals), followed by optional whitespace, followed by letters (including Korean)
  // Using [a-zA-Z가-힣]+ to match English letters and Korean characters  
  const match = partsWithoutTrailingNumbers.match(/^(\d+\.?\d*)\s*([a-zA-Z가-힣]+)/);
  
  
  if (match) {
    return {
      quantity: parseFloat(match[1]), // Capture the number (allows decimals)
      unit: match[2]   // Capture the unit (English or Korean)
    };
  }

  // Fallback if no match - if it's just a number, treat it as "items"
  const numMatch = partsWithoutTrailingNumbers.match(/^(\d+\.?\d*)$/);
  if (numMatch) {
    // If specification is just a number, set unit to "items"
    return { quantity: parseFloat(numMatch[1]), unit: "items" };
  }

  // If we can't parse anything, return default
  return { quantity: 1, unit: "items" };
}


// Function to handle the response
function processResponse(resp) {
  // print a string summary
  //console.log(resp.inference.toString());
  
  
  // Calculate VAT for items where it's null
  if (resp.rawHttp && resp.rawHttp.inference && resp.rawHttp.inference.result && resp.rawHttp.inference.result.fields && resp.rawHttp.inference.result.fields.line_items && resp.rawHttp.inference.result.fields.line_items.items) {
    const lineItems = resp.rawHttp.inference.result.fields.line_items.items;
    
    console.log('\n========== OCR Mindee Results ==========');
    
    lineItems.forEach((item, index) => {
      const itemName = item.fields.item_name?.value;
      const specification = item.fields.specification?.value;
      const quantity = item.fields.quantity?.value;
      const unitPrice = item.fields.unit_price?.value;
      const supplyPrice = item.fields.supply_price?.value;
      let vat = item.fields.vat?.value;
      const initialQuantity = extractSpecificationWordQuantity(specification).quantity;
      const unit = extractSpecificationWordQuantity(specification).unit;
      const multiplier = extractMultiplier(specification);
      let cpei;
      if (vat < Math.round(supplyPrice*0.1)) {
        cpei=Math.round(supplyPrice/(multiplier*initialQuantity*quantity));
      }
      else {
        cpei=Math.round((supplyPrice+vat)/(multiplier*initialQuantity*quantity));
      }
      console.log(`Item ${index + 1}:`);
        console.log(`  Item Name: ${itemName}`);
        console.log(`  Specification: ${specification}`);
        console.log(`  Quantity: ${quantity}`);
        console.log(`  Unit Price: ${unitPrice}`);
        console.log(`  Supply Price: ${supplyPrice}`);
      console.log(`  VAT: ${vat}`);
      console.log(`  Cost per each ingredient : ${cpei} per ${unit}`);
      console.log('-----------------------------------------------\n');
    });
    
    console.log('===============================================\n');
  }
}



// Start the OCR processing
processOCR();
