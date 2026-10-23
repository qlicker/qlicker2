import mongoose from 'mongoose';
import { generateMeteorId } from '../utils/meteorId.js';

const ImageSchema = new mongoose.Schema(
  {
    _id: { type: String, default: () => generateMeteorId() },
    url: { type: String, required: true },
    key: { type: String, default: '' },
    UID: { type: String, required: true },
    type: { type: String, default: '' },
    size: { type: Number, default: 0 },
    createdAt: { type: Date, default: Date.now },
  },
  {
    collection: 'images',
    timestamps: false,
  }
);

// Indexes for query performance (matching legacy database indexes)
ImageSchema.index({ UID: 1 });

const Image = mongoose.model('Image', ImageSchema);

export default Image;
