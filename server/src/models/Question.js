import mongoose from 'mongoose';
import { generateMeteorId } from '../utils/meteorId.js';

const OptionSchema = new mongoose.Schema(
  {
    wysiwyg: { type: Boolean, default: false },
    correct: { type: Boolean, default: false },
    answer: { type: String, default: '' },
    content: { type: String, default: '' },
    plainText: { type: String, default: '' },
  },
  { _id: false }
);

const TagSchema = new mongoose.Schema(
  {
    value: { type: String },
    label: { type: String },
    className: { type: String },
  },
  { _id: false }
);

const AttemptSchema = new mongoose.Schema(
  {
    number: { type: Number },
    closed: { type: Boolean, default: false },
  },
  { _id: false }
);

const WordFrequencyEntrySchema = new mongoose.Schema(
  {
    text: { type: String, required: true },
    count: { type: Number, required: true },
  },
  { _id: false }
);

const WordCloudDataSchema = new mongoose.Schema(
  {
    wordFrequencies: { type: [WordFrequencyEntrySchema], default: [] },
    visible: { type: Boolean, default: false },
    generatedAt: { type: Date },
  },
  { _id: false }
);

const HistogramBinSchema = new mongoose.Schema(
  {
    label: { type: String, required: true },
    count: { type: Number, required: true },
    min: { type: Number },
    max: { type: Number },
  },
  { _id: false }
);

const HistogramDataSchema = new mongoose.Schema(
  {
    bins: { type: [HistogramBinSchema], default: [] },
    overflowLow: { type: Number, default: 0 },
    overflowHigh: { type: Number, default: 0 },
    rangeMin: { type: Number },
    rangeMax: { type: Number },
    numBins: { type: Number },
    visible: { type: Boolean, default: false },
    generatedAt: { type: Date },
  },
  { _id: false }
);

const AttemptDistributionEntrySchema = new mongoose.Schema(
  {
    index: { type: Number, required: true },
    answer: { type: String, default: '' },
    correct: { type: Boolean, default: false },
    count: { type: Number, default: 0 },
  },
  { _id: false }
);

const AttemptAnswerEntrySchema = new mongoose.Schema(
  {
    studentUserId: { type: String, default: '' },
    answer: { type: mongoose.Schema.Types.Mixed },
    answerWysiwyg: { type: String, default: '' },
    createdAt: { type: Date },
    updatedAt: { type: Date },
  },
  { _id: false }
);

const AttemptStatsEntrySchema = new mongoose.Schema(
  {
    number: { type: Number, required: true },
    type: { type: String, default: 'unknown' },
    total: { type: Number, default: 0 },
    distribution: { type: [AttemptDistributionEntrySchema], default: [] },
    answers: { type: [AttemptAnswerEntrySchema], default: [] },
    values: { type: [Number], default: [] },
    sum: { type: Number, default: 0 },
    sumSquares: { type: Number, default: 0 },
    min: { type: Number, default: null },
    max: { type: Number, default: null },
  },
  { _id: false }
);

const SessionPropertiesSchema = new mongoose.Schema(
  {
    lastAttemptNumber: { type: Number, default: 0 },
    lastAttemptResponseCount: { type: Number, default: 0 },
    lastAttemptAggregateCount: { type: Number, default: 0 },
  },
  { _id: false }
);

const SessionOptionsSchema = new mongoose.Schema(
  {
    hidden: { type: Boolean, default: false },
    stats: { type: Boolean, default: false },
    correct: { type: Boolean, default: false },
    responseListVisible: { type: Boolean, default: true },
    points: { type: Number, default: 1 },
    maxAttempts: { type: Number, default: 1 },
    attemptWeights: { type: [Number], default: [] },
    attempts: { type: [AttemptSchema], default: [] },
    attemptStats: { type: [AttemptStatsEntrySchema], default: [] },
    wordCloudData: { type: WordCloudDataSchema },
    histogramData: { type: HistogramDataSchema },
  },
  { _id: false }
);

const QuestionSchema = new mongoose.Schema(
  {
    _id: { type: String, default: () => generateMeteorId() },
    plainText: { type: String, default: '' },
    type: { type: Number, required: true },
    content: { type: String, default: '' },
    options: { type: [OptionSchema], default: [] },
    toleranceNumerical: { type: Number },
    correctNumerical: { type: Number },
    creator: { type: String, required: true },
    owner: { type: String, default: '' },
    originalQuestion: { type: String, default: '' },
    originalCourse: { type: String, default: '' },
    sessionId: { type: String, default: '' },
    courseId: { type: String, default: '' },
    public: { type: Boolean, default: false },
    publicOnQlicker: { type: Boolean, default: false },
    publicOnQlickerForStudents: { type: Boolean, default: false },
    solution: { type: String, default: '' },
    solution_plainText: { type: String, default: '' },
    createdAt: { type: Date, default: Date.now },
    lastEditedAt: { type: Date },
    approved: { type: Boolean, default: true },
    tags: { type: [TagSchema], default: [] },
    sessionOptions: { type: SessionOptionsSchema },
    sessionProperties: { type: SessionPropertiesSchema },
    imagePath: { type: String, default: '' },
    studentCopyOfPublic: { type: Boolean, default: false },
    studentCreated: { type: Boolean, default: false },
  },
  {
    collection: 'questions',
    timestamps: false,
  }
);

// Indexes for query performance (matching legacy database indexes)
QuestionSchema.index({ sessionId: 1 });
QuestionSchema.index({ courseId: 1 });
QuestionSchema.index({ owner: 1 });
QuestionSchema.index({ courseId: 1, createdAt: -1 });
QuestionSchema.index({ originalCourse: 1 });
QuestionSchema.index({ 'tags.value': 1 });
QuestionSchema.index({
  plainText: 'text',
  'options.plainText': 'text',
  'options.answer': 'text',
});

const Question = mongoose.model('Question', QuestionSchema);

export default Question;
