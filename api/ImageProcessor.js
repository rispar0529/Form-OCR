const express = require('express');
const router = express.Router();
const multer = require('multer');
const tesseract = require('tesseract.js')
const path = require('path');
const sharp = require('sharp')


const BUFFER_PIXEL = 15;


const upload = multer({dest: path.join(__dirname, "..", "uploads")});

async function Worker(location, rect){
    const worker = await tesseract.createWorker(["eng", "hin"]);
    let rectangle = {left: rect.x, top: rect.y, width: rect.width, height: rect.height};
    const {data: {text}} = await worker.recognize(location, {rectangle})
    await worker.terminate();
    return text;
}

// The function looks for the value in the key-value that's provided in the json object for the form.
// It then stores the coordinates of the bounding box of these values which will later be used to calculate the scan regions for each form fields
async function GetScanRegion(location){

    try{
        const worker = await tesseract.createWorker(["eng", "hin"], 1, {
            logger: m => console.log(m),
        });  

        let rectangles = [];

        const result = await worker.recognize(location);
        let wordMatch= [];
        for(const property in data){
            wordMatch.push(data[property].split(" ")[0]);
        }
        console.log(result.data.text);

        for(const word in result.data.words){
            for(const property in data){
                if(data[property].split(" ")[0] === result.data.words[word].text){
                    let prop;
                    prop = property;
                    const rectangle = {
                        text: result.data.words[word].text,
                        ogText: data[prop],
                        property: prop,
                        x: result.data.words[word].bbox.x0 - BUFFER_PIXEL,
                        y: result.data.words[word].bbox.y0 - BUFFER_PIXEL,
                        width: result.data.words[word].bbox.x1 - result.data.words[word].bbox.x0 + 2*BUFFER_PIXEL,
                        height: result.data.words[word].bbox.y1 - result.data.words[word].bbox.y0 + 2*BUFFER_PIXEL
                    }
                    rectangles.push(rectangle);
                    break;
                }
            }

        }

        const {width, height} = await sharp(location).metadata();

        for(let i = 0; i+1 < rectangles.length; i++){
            if(Math.abs((rectangles[i].x - rectangles[i+1].x)) > BUFFER_PIXEL){
                let j = i+1;
                while(j < rectangles.length){
                    if(Math.abs(rectangles[i].y - Math.abs(rectangles[j].y)) > BUFFER_PIXEL){
                        break;
                    }
                    j++;
                }
                rectangles[i].search = {
                    x: rectangles[i].x,
                    y: rectangles[i].y,
                    width: (rectangles[i+1].x - rectangles[i].x)<0?(width - rectangles[i].x):(rectangles[i+1].x - rectangles[i].x),
                    height: (j<rectangles.length)?((rectangles[j].y - rectangles[i].y < 0 ? rectangles[i].y - rectangles[j].y : rectangles[j].y - rectangles[i].y)):height - rectangles[i].y,
                }
            }
            else{
                rectangles[i].search = {
                    x: rectangles[i].x,
                    y: rectangles[i].y,
                    width: width - rectangles[i].x,
                    height: rectangles[i+1].y - rectangles[i].y
                }
            }
        }

        rectangles[rectangles.length-1].search = {
            x: rectangles[rectangles.length-1].x,
            y: rectangles[rectangles.length-1].y,
            width: width - rectangles[rectangles.length-1].x,
            height: height - rectangles[rectangles.length-1].y
        } 
        console.log(rectangles);
        await worker.terminate();
        return rectangles;
    } catch(err) {
        console.error("Error performing OCR on image", err);
    }
}

//Helper function for drawing bounding boxes for texts
async function drawRectangles(imagePath, rectangles, outputPath) {
    try{
        const svgRectangles = rectangles
            .map(
                (rect) => `
                <rect x="${rect.x}" y="${rect.y}" width="${rect.width}" height="${rect.height}" 
                fill="none" stroke="blue" stroke-width="1" />
                <text x="${rect.x + 2}" y="${rect.y - 2}" fill="blue" font-size="10">${rect.text}</text>
                `
            )
            .join("");

        const svgRectangles1 = rectangles
            .map(
                (rect) => `
                <rect x="${rect.search.x}" y="${rect.search.y}" width="${rect.search.width}" height="${rect.search.height}" 
                fill="none" stroke="red" stroke-width="1" />
                <text x="${rect.x + 2}" y="${rect.y - 2}" fill="blue" font-size="10">${rect.text}</text>
                `
            )
            .join("");

        const {width, height} = await sharp(imagePath).metadata();
        const svgOverlay = `
            <svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
            ${svgRectangles}
        ${svgRectangles1}
            </svg>
            `;

        await sharp(imagePath)
            .composite([{ input: Buffer.from(svgOverlay), blend: "over" }])
            .toFile(outputPath);

        console.log("Image with rectangles saved to:", outputPath);
    } catch(err) {
        console.error("Error in making the bounding boxes", err);
    }
}



// Post request handler for '/process' for form filling by OCR
router.post('/', upload.single('processImage'), (req, res) => {

    data = req.jsondata;
    console.log(req.file);
    const loc = path.resolve(__dirname, "..", req.file.path);
    console.log(loc);
    try{
    GetScanRegion(loc)
        .then((rectangles) => {

            //The drawRectangles() is just for debugging and cross verification. The image can be found under the uploads folder with the name "TextBoundingBox"
            drawRectangles(loc, rectangles, path.join(__dirname, "..", "uploads", "TextBoundingBox"));

            let formData = {}
            const promises = rectangles.map((rect) => {
                const rectangle = {
                    x: rect.search.x,
                    y: rect.search.y,
                    width: rect.search.width,
                    height: rect.search.height,
                };

                return Worker(loc, rectangle).then((text) => {
                    //The regular expression is separated into two groups, one is the value that is used in anchoring the boxes which is also the value thats provided in the json object, and the other is the value thats to be scanned and filled in the form field
                    //The first group consists of the the value in json object, and also includes characters '|:\n[] ' which can be scanning artifacts or characters we want to ignore
                    //the second group consists of unicode characters which represent the Devanagiri scripture, characters from A-Z, a-z, 0-9, and characters which you may encouter in addresses and emails, '#*/,@ '
                    const regex = RegExp(`(${rect.ogText}[\n|:[ ]*)([\\u0900-\\u097FA-Za-z0-9@#*/,. ]*)`);
                    console.log(regex.exec(text));
                    const value = regex.exec(text) ? regex.exec(text)[2] : " ";     //If the regex.exec() returns null, we give out empty string
                    formData[`${rect.property}`] = value;
                });
            });

            return Promise.all(promises).then(() => formData);
        })
        .then((formData) => {
            console.log(formData)
            res.json(formData);
        })
    } catch(err) {
        console.error("Error in the post", err);
    }
});

module.exports = router
